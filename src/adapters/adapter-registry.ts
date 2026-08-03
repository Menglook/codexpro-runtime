import fsp from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProjectCommand, ProjectSignal } from "../project/types.js";
import type { AdapterDetection, AdapterDetectionContext, AdapterProfile, CodexProAdapter } from "./types.js";

function signal(kind: string, relPath: string, detail: string): ProjectSignal {
  return { kind, path: relPath, detail };
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fsp.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(absPath: string, maxBytes = 120_000): Promise<string | undefined> {
  try {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return await fsp.readFile(absPath, "utf8");
  } catch {
    return undefined;
  }
}

async function readJsonIfExists(absPath: string): Promise<Record<string, unknown> | undefined> {
  const raw = await readTextIfExists(absPath);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function createAdapterDetectionContext(root: string): AdapterDetectionContext {
  return {
    root,
    fileExists: (relPath: string) => fileExists(path.join(root, relPath)),
    readText: (relPath: string, maxBytes?: number) => readTextIfExists(path.join(root, relPath), maxBytes),
    readJson: (relPath: string) => readJsonIfExists(path.join(root, relPath)),
    collectExisting: async (relPaths: string[]) => {
      const found: string[] = [];
      for (const relPath of relPaths) {
        if (await fileExists(path.join(root, relPath))) found.push(relPath);
      }
      return found;
    }
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = value?.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function uniqueSignals(values: ProjectSignal[]): ProjectSignal[] {
  const out: ProjectSignal[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    const key = `${item.kind}\0${item.path}\0${item.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function uniqueCommands(values: ProjectCommand[]): ProjectCommand[] {
  const out: ProjectCommand[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    const key = `${item.name}\0${item.command}\0${item.cwd ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function packageManagerFromSignals(signals: ProjectSignal[]): string | undefined {
  if (signals.some((item) => item.path === "pnpm-lock.yaml")) return "pnpm";
  if (signals.some((item) => item.path === "yarn.lock")) return "yarn";
  if (signals.some((item) => item.path === "bun.lockb" || item.path === "bun.lock")) return "bun";
  if (signals.some((item) => item.path === "package-lock.json")) return "npm";
  if (signals.some((item) => item.path === "package.json")) return "npm";
  return undefined;
}

function commandForPackageManager(packageManager: string, script: string): string {
  if (packageManager === "pnpm") return `pnpm run ${script}`;
  if (packageManager === "yarn") return `yarn run ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

function scriptsFromPackageJson(packageJson: Record<string, unknown> | undefined): Record<string, string> {
  const scripts = packageJson?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function commandsForScripts(packageManager: string | undefined, packageJson: Record<string, unknown> | undefined, names: string[], timeoutMs: number): ProjectCommand[] {
  const pm = packageManager ?? "npm";
  const scripts = scriptsFromPackageJson(packageJson);
  const commands: ProjectCommand[] = [];
  for (const name of names) {
    if (scripts[name]) commands.push({ name, command: commandForPackageManager(pm, name), timeout_ms: timeoutMs });
  }
  return commands;
}

function dependencyNames(packageJson: Record<string, unknown> | undefined): Set<string> {
  const dependencies = {
    ...(packageJson?.dependencies && typeof packageJson.dependencies === "object" && !Array.isArray(packageJson.dependencies) ? packageJson.dependencies as Record<string, unknown> : {}),
    ...(packageJson?.devDependencies && typeof packageJson.devDependencies === "object" && !Array.isArray(packageJson.devDependencies) ? packageJson.devDependencies as Record<string, unknown> : {})
  };
  return new Set(Object.keys(dependencies));
}

async function addExistingSignals(context: AdapterDetectionContext, checks: Array<{ path: string; kind: string; detail: string }>): Promise<ProjectSignal[]> {
  const signals: ProjectSignal[] = [];
  for (const check of checks) {
    if (await context.fileExists(check.path)) signals.push(signal(check.kind, check.path, check.detail));
  }
  return signals;
}

async function existingImportantPaths(context: AdapterDetectionContext, candidates: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await context.fileExists(candidate)) found.push(candidate);
  }
  return found;
}

async function detectDockerServices(context: AdapterDetectionContext): Promise<string[]> {
  for (const file of ["docker-compose.yml", "docker-compose.yaml"]) {
    const raw = await context.readText(file);
    if (!raw) continue;
    try {
      const parsed = parseYaml(raw) as { services?: unknown } | undefined;
      const services = parsed?.services;
      if (services && typeof services === "object" && !Array.isArray(services)) return Object.keys(services).sort();
    } catch {
      return [];
    }
  }
  return [];
}

function disabled(adapter: string): AdapterDetection {
  return { adapter, enabled: false };
}

function createNodeAdapter(): CodexProAdapter {
  return {
    id: "node",
    name: "Node Adapter",
    description: "Detects Node.js package managers, frameworks, scripts, and common entrypoints.",
    async detect(context) {
      const signals = await addExistingSignals(context, [
        { path: "package.json", kind: "node", detail: "Node.js package manifest" },
        { path: "package-lock.json", kind: "node", detail: "npm lockfile" },
        { path: "pnpm-lock.yaml", kind: "node", detail: "pnpm lockfile" },
        { path: "yarn.lock", kind: "node", detail: "Yarn lockfile" },
        { path: "bun.lockb", kind: "node", detail: "Bun lockfile" },
        { path: "bun.lock", kind: "node", detail: "Bun lockfile" },
        { path: "tsconfig.json", kind: "node", detail: "TypeScript configuration" }
      ]);
      if (!signals.length) return disabled("node");

      const packageJson = await context.readJson("package.json");
      const packageManager = packageManagerFromSignals(signals);
      const scripts = scriptsFromPackageJson(packageJson);
      const names = dependencyNames(packageJson);
      const frameworks = new Set<string>();
      if (names.has("typescript") || signals.some((item) => item.path === "tsconfig.json")) frameworks.add("TypeScript");
      if (names.has("express")) frameworks.add("Express");
      if (names.has("@modelcontextprotocol/sdk")) frameworks.add("MCP SDK");
      if (names.has("zod")) frameworks.add("Zod");
      if (names.has("next")) frameworks.add("Next.js");
      if (names.has("react")) frameworks.add("React");
      if (names.has("vite")) frameworks.add("Vite");

      const entrypoints = await context.collectExisting([
        "src/server.ts",
        "src/http.ts",
        "src/stdio.ts",
        "src/index.ts",
        "index.js",
        "server.js"
      ]);
      const importantPaths = await existingImportantPaths(context, [
        "src",
        "app",
        "pages",
        "components",
        "frontend",
        "backend",
        "scripts",
        "templates",
        "schemas",
        "package.json",
        "tsconfig.json"
      ]);
      const start = commandsForScripts(packageManager, packageJson, ["dev", "start", "start:http", "start:stdio", "connect", "connect:stable"], 120_000);
      const build = commandsForScripts(packageManager, packageJson, ["build"], 120_000);
      const test = commandsForScripts(packageManager, packageJson, ["test", "smoke", "check"], 120_000);
      const lint = commandsForScripts(packageManager, packageJson, ["lint", "typecheck"], 90_000);
      const suggested = uniqueCommands([
        ...commandsForScripts(packageManager, packageJson, ["typecheck", "lint"], 60_000),
        ...build,
        ...commandsForScripts(packageManager, packageJson, ["smoke"], 120_000),
        ...commandsForScripts(packageManager, packageJson, ["test", "check"], 90_000)
      ]).slice(0, 6);
      const frontendFrameworks = ["Next.js", "React", "Vite"];
      const hasFrontend = [...frameworks].some((item) => frontendFrameworks.includes(item));

      return {
        adapter: "node",
        enabled: true,
        signals,
        package_manager: packageManager,
        primary_language: "TypeScript/JavaScript",
        frameworks: [...frameworks],
        important_paths: importantPaths,
        entrypoints,
        commands: { start, build, test, lint, suggested },
        has_frontend: hasFrontend,
        has_backend: true,
        has_browser_app: hasFrontend || Boolean(scripts["browser-smoke"]),
        metadata: { package_scripts: Object.keys(scripts).sort() }
      };
    }
  };
}

function createDockerAdapter(): CodexProAdapter {
  return {
    id: "docker",
    name: "Docker Adapter",
    description: "Detects Dockerfiles, Compose files, services, database-like services, and Docker risk paths.",
    async detect(context) {
      const signals = await addExistingSignals(context, [
        { path: "Dockerfile", kind: "docker", detail: "Docker build file" },
        { path: "docker-compose.yml", kind: "docker", detail: "Docker Compose file" },
        { path: "docker-compose.yaml", kind: "docker", detail: "Docker Compose file" }
      ]);
      if (!signals.length) return disabled("docker");
      const dockerServices = await detectDockerServices(context);
      const hasDatabase = dockerServices.some((service) => /(db|postgres|mysql|maria|redis|mongo)/i.test(service));
      const hasCompose = signals.some((item) => item.path === "docker-compose.yml" || item.path === "docker-compose.yaml");
      return {
        adapter: "docker",
        enabled: true,
        signals,
        frameworks: hasCompose ? ["Docker Compose"] : [],
        important_paths: signals.map((item) => item.path),
        risk_paths: signals.filter((item) => item.path.startsWith("docker-compose.")).map((item) => item.path),
        entrypoints: signals.map((item) => item.path),
        docker_services: dockerServices,
        has_docker: true,
        has_database: hasDatabase
      };
    }
  };
}

function createDatabaseReadonlyAdapter(): CodexProAdapter {
  return {
    id: "database-readonly",
    name: "Database Read-only Adapter",
    description: "Detects database manifests, migration directories, SQLite files, database-like Docker services, and read-only audit surfaces.",
    async detect(context) {
      const signals = await addExistingSignals(context, [
        { path: "prisma/schema.prisma", kind: "database", detail: "Prisma schema" },
        { path: "drizzle.config.ts", kind: "database", detail: "Drizzle configuration" },
        { path: "drizzle.config.js", kind: "database", detail: "Drizzle configuration" },
        { path: "knexfile.js", kind: "database", detail: "Knex configuration" },
        { path: "knexfile.ts", kind: "database", detail: "Knex configuration" },
        { path: "alembic.ini", kind: "database", detail: "Alembic migration configuration" },
        { path: "migrations", kind: "database", detail: "Database migrations directory" },
        { path: "alembic", kind: "database", detail: "Alembic migrations directory" },
        { path: "db", kind: "database", detail: "Database directory" },
        { path: "database", kind: "database", detail: "Database directory" },
        { path: "database.sqlite", kind: "database", detail: "SQLite database file" },
        { path: "db.sqlite", kind: "database", detail: "SQLite database file" },
        { path: "app.db", kind: "database", detail: "SQLite database file" },
        { path: "data.db", kind: "database", detail: "SQLite database file" }
      ]);
      const dockerServices = await detectDockerServices(context);
      const databaseServices = dockerServices.filter((service) => /(db|postgres|postgresql|mysql|maria|mariadb|sqlite|mongo|redis)/i.test(service));
      for (const service of databaseServices) signals.push(signal("database", "docker-compose", `Database-like Docker service: ${service}`));

      const packageJson = await context.readJson("package.json");
      const names = dependencyNames(packageJson);
      const dbDependencies = ["@prisma/client", "prisma", "pg", "mysql", "mysql2", "sqlite3", "better-sqlite3", "knex", "drizzle-orm", "typeorm", "sequelize"].filter((name) => names.has(name));
      for (const dependency of dbDependencies) signals.push(signal("database", "package.json", `Database dependency: ${dependency}`));

      const pythonDependencyText = [
        (await context.readText("pyproject.toml", 240_000))?.toLowerCase() ?? "",
        (await context.readText("requirements.txt", 240_000))?.toLowerCase() ?? ""
      ].join("\n");
      const pythonDbDependencies = ["sqlalchemy", "psycopg", "psycopg2", "asyncpg", "pymysql", "mysqlclient", "sqlite"].filter((name) => pythonDependencyText.includes(name));
      for (const dependency of pythonDbDependencies) signals.push(signal("database", "python-manifest", `Python database dependency: ${dependency}`));

      if (!signals.length) return disabled("database-readonly");
      const importantPaths = await existingImportantPaths(context, [
        "prisma/schema.prisma",
        "drizzle.config.ts",
        "drizzle.config.js",
        "knexfile.js",
        "knexfile.ts",
        "alembic.ini",
        "migrations",
        "alembic",
        "db",
        "database",
        "docker-compose.yml",
        "docker-compose.yaml"
      ]);
      const riskPaths = await existingImportantPaths(context, ["migrations", "alembic", "db", "database", "mysql", "mysql-data", "db_data"]);
      return {
        adapter: "database-readonly",
        enabled: true,
        signals: uniqueSignals(signals),
        frameworks: uniqueStrings([...dbDependencies, ...pythonDbDependencies, ...databaseServices.map((service) => `service:${service}`)]),
        important_paths: importantPaths,
        risk_paths: riskPaths,
        docker_services: databaseServices,
        has_database: true,
        has_backend: true,
        metadata: {
          tools: ["database_readonly_query", "database_schema_summary"],
          allowed_sql: ["SELECT", "SHOW", "EXPLAIN"],
          forbidden_sql: ["DROP", "TRUNCATE", "DELETE", "UPDATE", "INSERT", "ALTER", "CREATE"],
          redaction: "database rows and CLI output are redacted before return"
        }
      };
    }
  };
}

function createPythonAdapter(): CodexProAdapter {
  return {
    id: "python",
    name: "Python / FastAPI Adapter",
    description: "Detects Python manifests, uv/Poetry/pip signals, pytest, Alembic risk markers, FastAPI entrypoints, and route surfaces.",
    async detect(context) {
      const signals = await addExistingSignals(context, [
        { path: "requirements.txt", kind: "python", detail: "Python requirements" },
        { path: "requirements-dev.txt", kind: "python", detail: "Python dev requirements" },
        { path: "pyproject.toml", kind: "python", detail: "Python project configuration" },
        { path: "uv.lock", kind: "python", detail: "uv lockfile" },
        { path: "poetry.lock", kind: "python", detail: "Poetry lockfile" },
        { path: "pytest.ini", kind: "python", detail: "pytest configuration" },
        { path: "alembic.ini", kind: "python", detail: "Alembic migration configuration" },
        { path: "app/main.py", kind: "python", detail: "Python/FastAPI application entrypoint" },
        { path: "backend/app/main.py", kind: "python", detail: "Python/FastAPI backend entrypoint" }
      ]);
      const pyproject = (await context.readText("pyproject.toml", 240_000))?.toLowerCase() ?? "";
      const requirements = [
        (await context.readText("requirements.txt", 240_000))?.toLowerCase() ?? "",
        (await context.readText("requirements-dev.txt", 240_000))?.toLowerCase() ?? ""
      ].join("\n");
      const dependencyText = `${pyproject}\n${requirements}`;
      const hasPythonDependencySignal = /\b(fastapi|pytest|uvicorn|alembic|sqlalchemy|pydantic)\b/.test(dependencyText);
      if (!signals.length && !hasPythonDependencySignal) return disabled("python");

      const frameworks = new Set<string>();
      if (/\bfastapi\b/.test(dependencyText) || await context.fileExists("app/main.py") || await context.fileExists("backend/app/main.py")) frameworks.add("FastAPI");
      if (/\buvicorn\b/.test(dependencyText)) frameworks.add("Uvicorn");
      if (/\bpytest\b/.test(dependencyText) || await context.fileExists("pytest.ini") || await context.fileExists("conftest.py")) frameworks.add("pytest");
      if (/\balembic\b/.test(dependencyText) || await context.fileExists("alembic.ini")) frameworks.add("Alembic");
      if (/\bsqlalchemy\b/.test(dependencyText)) frameworks.add("SQLAlchemy");
      if (/\bpydantic\b/.test(dependencyText)) frameworks.add("Pydantic");

      const packageManager = await context.fileExists("uv.lock") || /\[tool\.uv\]/.test(pyproject)
        ? "uv"
        : await context.fileExists("poetry.lock") || /\[tool\.poetry\]/.test(pyproject)
          ? "poetry"
          : "pip";
      const entrypoints = await context.collectExisting(["app/main.py", "main.py", "src/main.py", "backend/app/main.py", "backend/main.py", "app.py", "manage.py"]);
      const importantPaths = await existingImportantPaths(context, [
        "app",
        "api",
        "backend/app",
        "src",
        "tests",
        "requirements.txt",
        "requirements-dev.txt",
        "pyproject.toml",
        "pytest.ini",
        "uv.lock",
        "poetry.lock"
      ]);
      const riskPaths = await existingImportantPaths(context, ["alembic.ini", "migrations", "alembic", "db", "database", "mysql", "mysql-data", "db_data"]);
      const suggested: ProjectCommand[] = [];
      if (frameworks.has("pytest") || await context.fileExists("tests")) {
        const command = packageManager === "uv"
          ? "uv run pytest"
          : packageManager === "poetry"
            ? "poetry run pytest"
            : "python -m pytest";
        suggested.push({ name: "pytest", command, timeout_ms: 120_000 });
      }

      return {
        adapter: "python",
        enabled: true,
        signals,
        package_manager: packageManager,
        primary_language: "Python",
        frameworks: [...frameworks],
        important_paths: uniqueStrings([...signals.map((item) => item.path), ...importantPaths]),
        risk_paths: riskPaths,
        entrypoints,
        commands: { suggested },
        has_backend: true,
        has_database: frameworks.has("Alembic") || riskPaths.length > 0,
        has_browser_app: false,
        metadata: {
          safety_policy: [
            "do not run Alembic/database migrations by default",
            "run pytest only through structured arguments",
            "do not execute arbitrary Python shell strings"
          ]
        }
      };
    }
  };
}

function createPhpWordPressAdapter(): CodexProAdapter {
  return {
    id: "php-wordpress",
    name: "PHP / WordPress Adapter",
    description: "Detects Composer, WordPress, WooCommerce, theme/plugin directories, uploads, and wp-config risk paths.",
    async detect(context) {
      const signals = await addExistingSignals(context, [
        { path: "composer.json", kind: "php", detail: "Composer package manifest" },
        { path: "composer.lock", kind: "php", detail: "Composer lockfile" },
        { path: "wp-config.php", kind: "wordpress", detail: "WordPress configuration file" },
        { path: "wp-content", kind: "wordpress", detail: "WordPress content directory" },
        { path: "wp-content/themes", kind: "wordpress", detail: "WordPress themes directory" },
        { path: "wp-content/plugins", kind: "wordpress", detail: "WordPress plugins directory" },
        { path: "public/wp-config.php", kind: "wordpress", detail: "WordPress configuration file" },
        { path: "public/wp-content", kind: "wordpress", detail: "WordPress content directory" },
        { path: "web/wp-config.php", kind: "wordpress", detail: "WordPress configuration file" },
        { path: "web/wp-content", kind: "wordpress", detail: "WordPress content directory" },
        { path: "web/app", kind: "wordpress", detail: "Bedrock-style WordPress content directory" },
        { path: "web/app/themes", kind: "wordpress", detail: "Bedrock-style WordPress themes directory" },
        { path: "web/app/plugins", kind: "wordpress", detail: "Bedrock-style WordPress plugins directory" }
      ]);
      const composerJson = await context.readJson("composer.json");
      const composerDependencies = new Set<string>();
      for (const group of [composerJson?.require, composerJson?.["require-dev"]]) {
        if (!group || typeof group !== "object" || Array.isArray(group)) continue;
        for (const name of Object.keys(group)) composerDependencies.add(name.toLowerCase());
      }
      const hasComposer = signals.some((item) => item.path === "composer.json" || item.path === "composer.lock");
      const dependencyWordPress = ["johnpbloch/wordpress", "roots/wordpress", "roots/bedrock"].some((name) => composerDependencies.has(name));
      const isWordPress = signals.some((item) => item.kind === "wordpress") || dependencyWordPress;
      if (!signals.length && !isWordPress) return disabled("php-wordpress");

      const hasWooCommerce = await context.fileExists("wp-content/plugins/woocommerce")
        || await context.fileExists("wp-content/plugins/woocommerce.php")
        || await context.fileExists("public/wp-content/plugins/woocommerce")
        || await context.fileExists("web/wp-content/plugins/woocommerce")
        || await context.fileExists("web/app/plugins/woocommerce")
        || [...composerDependencies].some((name) => name.includes("woocommerce"));
      const frameworks = new Set<string>();
      if (hasComposer) frameworks.add("Composer");
      if (isWordPress) frameworks.add("WordPress");
      if (composerDependencies.has("roots/bedrock") || await context.fileExists("web/app")) frameworks.add("Bedrock");
      if (hasWooCommerce) frameworks.add("WooCommerce");

      const entrypoints = await context.collectExisting([
        "composer.json",
        "wp-config.php",
        "wp-content/themes",
        "wp-content/plugins",
        "public/wp-config.php",
        "public/wp-content/themes",
        "public/wp-content/plugins",
        "web/wp-config.php",
        "web/wp-content/themes",
        "web/wp-content/plugins",
        "web/app/themes",
        "web/app/plugins"
      ]);
      const importantPaths = await existingImportantPaths(context, [
        "composer.json",
        "composer.lock",
        "wp-content",
        "wp-content/themes",
        "wp-content/plugins",
        "public/wp-content",
        "web/wp-content",
        "web/app",
        "web/app/themes",
        "web/app/plugins"
      ]);
      const riskPaths = uniqueStrings([
        ...(await context.collectExisting([
          "wp-config.php",
          "public/wp-config.php",
          "web/wp-config.php",
          "wp-content/uploads",
          "public/wp-content/uploads",
          "web/wp-content/uploads",
          "web/app/uploads",
          "mysql",
          "mysql-data",
          "db_data"
        ])),
        isWordPress && await context.fileExists("wp-content") ? "wp-content/uploads" : undefined,
        isWordPress && await context.fileExists("public/wp-content") ? "public/wp-content/uploads" : undefined,
        isWordPress && await context.fileExists("web/wp-content") ? "web/wp-content/uploads" : undefined,
        isWordPress && await context.fileExists("web/app") ? "web/app/uploads" : undefined
      ]);
      const suggested: ProjectCommand[] = [];
      if (hasComposer) suggested.push({ name: "composer-validate", command: "composer validate --no-check-publish", timeout_ms: 60_000 });
      if (isWordPress) {
        suggested.push(
          { name: "wp-plugin-list", command: "wp plugin list", timeout_ms: 60_000 },
          { name: "wp-theme-list", command: "wp theme list", timeout_ms: 60_000 }
        );
      }

      return {
        adapter: "php-wordpress",
        enabled: true,
        signals,
        package_manager: hasComposer ? "composer" : undefined,
        primary_language: "PHP",
        frameworks: [...frameworks],
        important_paths: uniqueStrings([...importantPaths, ...entrypoints]),
        risk_paths: riskPaths,
        entrypoints,
        commands: { suggested },
        has_frontend: isWordPress,
        has_backend: true,
        has_browser_app: isWordPress,
        metadata: {
          composer_dependencies: [...composerDependencies].sort(),
          safety_policy: [
            "do not delete wp-content/uploads",
            "do not delete database volumes",
            "do not modify wp-config.php secrets",
            "do not directly mutate production WooCommerce orders or products"
          ]
        }
      };
    }
  };
}

function createBrowserExtensionAdapter(): CodexProAdapter {
  return {
    id: "browser-extension",
    name: "Browser Extension Adapter",
    description: "Detects browser extension manifests as browser-app surfaces.",
    async detect(context) {
      const signals = await addExistingSignals(context, [
        { path: "manifest.json", kind: "browser-extension", detail: "Browser extension manifest" }
      ]);
      if (!signals.length) return disabled("browser-extension");
      return {
        adapter: "browser-extension",
        enabled: true,
        signals,
        important_paths: ["manifest.json"],
        entrypoints: ["manifest.json"],
        has_frontend: true,
        has_browser_app: true
      };
    }
  };
}

function createMcpServerAdapter(): CodexProAdapter {
  return {
    id: "mcp-server",
    name: "MCP Server Adapter",
    description: "Detects CodexPro-style MCP server registration entrypoints.",
    async detect(context) {
      const signals = await addExistingSignals(context, [
        { path: "src/server.ts", kind: "mcp", detail: "MCP server registration entry" }
      ]);
      if (!signals.length) return disabled("mcp-server");
      return {
        adapter: "mcp-server",
        enabled: true,
        signals,
        entrypoints: ["src/server.ts"],
        important_paths: ["src/server.ts"],
        has_backend: true
      };
    }
  };
}

function createPlaywrightAdapterDetector(): CodexProAdapter {
  return {
    id: "playwright",
    name: "Playwright Adapter",
    description: "Detects Playwright availability without changing browser tool behavior.",
    async detect(context) {
      const packageJson = await context.readJson("package.json");
      const names = dependencyNames(packageJson);
      const entrypoints = await context.collectExisting(["playwright.config.ts", "playwright.config.js", "src/adapters/playwright-adapter.ts"]);
      if (!names.has("playwright") && !entrypoints.length) return disabled("playwright");
      return {
        adapter: "playwright",
        enabled: true,
        frameworks: ["Playwright"],
        important_paths: entrypoints,
        entrypoints,
        has_browser_app: Boolean(scriptsFromPackageJson(packageJson)["browser-smoke"])
      };
    }
  };
}

function createGitAdapter(): CodexProAdapter {
  return {
    id: "git",
    name: "Git Adapter",
    description: "Detects Git metadata and exposes read-only preparation plus explicit, Acceptance-receipt-gated finalization tools.",
    async detect(context) {
      if (!await context.fileExists(".git")) return disabled("git");
      const importantPaths = await context.collectExisting([".gitignore", ".gitattributes"]);
      return {
        adapter: "git",
        enabled: true,
        signals: [signal("git", ".git", "Git repository metadata")],
        important_paths: importantPaths,
        risk_paths: [".git"],
        metadata: {
          commit_policy: "acceptance-receipt-gated",
          prepare_tools: ["git_summary", "git_prepare_commit", "git_get_remote_state", "git_prepare"],
          finalize_tools: ["git_commit", "git_push", "git_finalize", "git_push_only"],
          auto_commit: false,
          auto_push: false
        }
      };
    }
  };
}

function createLegacyLanguageAdapter(): CodexProAdapter {
  return {
    id: "legacy-language-signals",
    name: "Legacy Language Signals Adapter",
    description: "Keeps existing Go, Rust, Java, and Makefile signals available while dedicated adapters are added later.",
    async detect(context) {
      const checks = [
        { path: "go.mod", kind: "go", detail: "Go module", language: "Go" },
        { path: "Cargo.toml", kind: "rust", detail: "Rust package manifest", language: "Rust" },
        { path: "pom.xml", kind: "java", detail: "Maven project", language: "Java" },
        { path: "Makefile", kind: "make", detail: "Makefile automation", language: undefined }
      ];
      const signals: ProjectSignal[] = [];
      let primaryLanguage: string | undefined;
      for (const check of checks) {
        if (!await context.fileExists(check.path)) continue;
        signals.push(signal(check.kind, check.path, check.detail));
        primaryLanguage ??= check.language;
      }
      if (!signals.length) return disabled("legacy-language-signals");
      return {
        adapter: "legacy-language-signals",
        enabled: true,
        signals,
        primary_language: primaryLanguage,
        important_paths: signals.map((item) => item.path),
        entrypoints: signals.map((item) => item.path),
        has_backend: signals.some((item) => ["go", "rust", "java"].includes(item.kind))
      };
    }
  };
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, CodexProAdapter>();

  register(adapter: CodexProAdapter): this {
    if (this.adapters.has(adapter.id)) throw new Error(`Adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  list(): CodexProAdapter[] {
    return [...this.adapters.values()];
  }

  async detect(context: AdapterDetectionContext): Promise<AdapterDetection[]> {
    const detections: AdapterDetection[] = [];
    for (const adapter of this.adapters.values()) {
      detections.push(await adapter.detect(context));
    }
    return detections;
  }
}

export function createDefaultProjectAdapters(): CodexProAdapter[] {
  return [
    createNodeAdapter(),
    createMcpServerAdapter(),
    createPlaywrightAdapterDetector(),
    createBrowserExtensionAdapter(),
    createDockerAdapter(),
    createDatabaseReadonlyAdapter(),
    createPythonAdapter(),
    createPhpWordPressAdapter(),
    createGitAdapter(),
    createLegacyLanguageAdapter()
  ];
}

export function createDefaultAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const adapter of createDefaultProjectAdapters()) registry.register(adapter);
  return registry;
}

export function mergeAdapterDetections(detections: AdapterDetection[]): AdapterProfile {
  const enabled = detections.filter((item) => item.enabled);
  const signals = uniqueSignals(enabled.flatMap((item) => item.signals ?? []));
  const commands = {
    start: uniqueCommands(enabled.flatMap((item) => item.commands?.start ?? [])),
    build: uniqueCommands(enabled.flatMap((item) => item.commands?.build ?? [])),
    test: uniqueCommands(enabled.flatMap((item) => item.commands?.test ?? [])),
    lint: uniqueCommands(enabled.flatMap((item) => item.commands?.lint ?? [])),
    suggested: uniqueCommands(enabled.flatMap((item) => item.commands?.suggested ?? []))
  };
  return {
    adapters: uniqueStrings(enabled.map((item) => item.adapter)),
    signals,
    package_manager: enabled.map((item) => item.package_manager).find((item): item is string => Boolean(item)),
    primary_language: enabled.map((item) => item.primary_language).find((item): item is string => Boolean(item)) ?? resolvePrimaryLanguage(signals),
    frameworks: uniqueStrings(enabled.flatMap((item) => item.frameworks ?? [])),
    important_paths: uniqueStrings(enabled.flatMap((item) => item.important_paths ?? [])),
    risk_paths: uniqueStrings(enabled.flatMap((item) => item.risk_paths ?? [])),
    entrypoints: uniqueStrings(enabled.flatMap((item) => item.entrypoints ?? [])),
    docker_services: uniqueStrings(enabled.flatMap((item) => item.docker_services ?? [])),
    commands,
    has_docker: enabled.some((item) => item.has_docker === true),
    has_database: enabled.some((item) => item.has_database === true),
    has_frontend: enabled.some((item) => item.has_frontend === true),
    has_backend: enabled.some((item) => item.has_backend === true),
    has_browser_app: enabled.some((item) => item.has_browser_app === true)
  };
}

export async function detectProjectWithAdapters(root: string, registry = createDefaultAdapterRegistry()): Promise<AdapterProfile> {
  return mergeAdapterDetections(await registry.detect(createAdapterDetectionContext(root)));
}

export function resolveProjectKind(signals: ProjectSignal[]): string {
  const kinds = new Set(signals.map((item) => item.kind));
  if (kinds.has("wordpress")) return "wordpress";
  if (kinds.has("node") && kinds.has("mcp")) return "node-mcp-server";
  if (kinds.has("browser-extension")) return "browser-extension";
  if (kinds.has("node")) return "node";
  if (kinds.has("python")) return "python";
  if (kinds.has("go")) return "go";
  if (kinds.has("rust")) return "rust";
  if (kinds.has("java")) return "java";
  if (kinds.has("php")) return "php";
  if (kinds.has("docker")) return "dockerized-project";
  return "generic";
}

export function resolvePrimaryLanguage(signals: ProjectSignal[]): string | undefined {
  const kinds = new Set(signals.map((item) => item.kind));
  if (kinds.has("node")) return "TypeScript/JavaScript";
  if (kinds.has("python")) return "Python";
  if (kinds.has("go")) return "Go";
  if (kinds.has("rust")) return "Rust";
  if (kinds.has("java")) return "Java";
  if (kinds.has("php") || kinds.has("wordpress")) return "PHP";
  return undefined;
}
