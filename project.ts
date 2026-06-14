/**
 * Project context detection via filesystem scan.
 * Runs ONCE at session_start — caches in memory.
 * Zero latency for subsequent optimizations.
 *
 * Detects: language, runtime, framework, package manager, project type.
 * Mirrors Prompt-Optimizer Phase 0 (Project Detection).
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectContext {
	/** Primary programming language */
	language: string;
	/** Runtime (e.g., "node", "bun", "deno", "go", "python", "jvm") */
	runtime?: string;
	/** Framework (e.g., "next.js", "react", "django", "spring boot") */
	framework?: string;
	/** Package manager (e.g., "npm", "pnpm", "yarn", "cargo", "pip") */
	packageManager?: string;
	/** Project type */
	type: "single" | "monorepo";
}

// ──────────────────────────────────────────────
//  Cache — populated once at session_start
// ──────────────────────────────────────────────

let cachedContext: ProjectContext | null = null;
let detectionAttempted = false;

// ──────────────────────────────────────────────
//  Detection helpers
// ──────────────────────────────────────────────

interface PackageJson {
	workspaces?: string[];
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	packageManager?: string;
}

async function readJSON<T>(filePath: string): Promise<T | null> {
	try {
		const raw = await readFile(filePath, "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await readFile(filePath, "utf-8");
		return true;
	} catch {
		return false;
	}
}

function detectFrameworkFromDeps(
	deps: Record<string, string> | undefined,
): string | undefined {
	if (!deps) return undefined;

	const frameworkMap: Array<[string, string]> = [
		["next", "Next.js"],
		["@angular/core", "Angular"],
		["nuxt", "Nuxt"],
		["svelte", "Svelte"],
		["vue", "Vue"],
		["react", "React"],
		["express", "Express"],
		["fastify", "Fastify"],
		["nestjs", "NestJS"],
		["django", "Django"],
		["flask", "Flask"],
		["spring-boot", "Spring Boot"],
		["quarkus", "Quarkus"],
		["rails", "Rails"],
		["laravel", "Laravel"],
	];

	for (const [pkg, name] of frameworkMap) {
		if (pkg in deps) return name;
	}

	return undefined;
}

function detectPackageManager(pkg: PackageJson): string | undefined {
	if (pkg.packageManager) {
		return pkg.packageManager.split("@")[0];
	}
	return undefined;
}

function isMonorepo(pkg: PackageJson): boolean {
	return !!(pkg.workspaces && pkg.workspaces.length > 0);
}

// ──────────────────────────────────────────────
//  Main detection function
// ──────────────────────────────────────────────

/**
 * Detect project context from the workspace root.
 * Reads files lazily; caches result forever.
 *
 * @param workspaceRoot - Path to the project root (usually process.cwd())
 */
export async function detectProjectContext(
	workspaceRoot: string,
): Promise<ProjectContext | null> {
	if (detectionAttempted) return cachedContext;
	detectionAttempted = true;

	// JavaScript / TypeScript
	const pkgJson = await readJSON<PackageJson>(join(workspaceRoot, "package.json"));
	if (pkgJson) {
		const hasTs =
			!!pkgJson.devDependencies?.typescript ||
			!!pkgJson.dependencies?.typescript ||
			(await fileExists(join(workspaceRoot, "tsconfig.json")));
		const framework = detectFrameworkFromDeps(pkgJson.dependencies) ??
			detectFrameworkFromDeps(pkgJson.devDependencies);
		const pm = detectPackageManager(pkgJson);
		const isMono = isMonorepo(pkgJson);

		cachedContext = {
			language: hasTs ? "TypeScript" : "JavaScript",
			runtime: "node",
			framework,
			packageManager: pm,
			type: isMono ? "monorepo" : "single",
		};
		return cachedContext;
	}

	// Go
	if (await fileExists(join(workspaceRoot, "go.mod"))) {
		cachedContext = {
			language: "Go",
			runtime: "go",
			type: "single",
		};
		return cachedContext;
	}

	// Python
	if (await fileExists(join(workspaceRoot, "pyproject.toml"))) {
		cachedContext = {
			language: "Python",
			runtime: "python",
			type: "single",
		};
		return cachedContext;
	}
	if (await fileExists(join(workspaceRoot, "requirements.txt"))) {
		cachedContext = {
			language: "Python",
			runtime: "python",
			type: "single",
		};
		return cachedContext;
	}

	// Rust
	if (await fileExists(join(workspaceRoot, "Cargo.toml"))) {
		cachedContext = {
			language: "Rust",
			runtime: "rust",
			packageManager: "cargo",
			type: "single",
		};
		return cachedContext;
	}

	// Java / Kotlin
	if (await fileExists(join(workspaceRoot, "build.gradle")) ||
		await fileExists(join(workspaceRoot, "build.gradle.kts"))) {
		cachedContext = {
			language: "Java/Kotlin",
			runtime: "jvm",
			type: "single",
		};
		return cachedContext;
	}
	if (await fileExists(join(workspaceRoot, "pom.xml"))) {
		cachedContext = {
			language: "Java",
			runtime: "jvm",
			type: "single",
		};
		return cachedContext;
	}

	// Ruby
	if (await fileExists(join(workspaceRoot, "Gemfile"))) {
		cachedContext = {
			language: "Ruby",
			runtime: "ruby",
			type: "single",
		};
		return cachedContext;
	}

	// PHP
	if (await fileExists(join(workspaceRoot, "composer.json"))) {
		cachedContext = {
			language: "PHP",
			runtime: "php",
			type: "single",
		};
		return cachedContext;
	}

	// .NET — scan directory for .csproj or .sln files
	try {
		const entries = await readdir(workspaceRoot);
		const hasDotNet = entries.some(
			(e) => e.endsWith(".csproj") || e.endsWith(".sln"),
		);
		if (hasDotNet) {
			cachedContext = {
				language: "C#",
				runtime: "dotnet",
				packageManager: "nuget",
				type: "single",
			};
			return cachedContext;
		}
	} catch {
		// readdir failed — skip .NET detection
	}

	cachedContext = {
		language: "Unknown",
		type: "single",
	};
	return cachedContext;
}

/**
 * Return the cached context (null if not yet detected).
 */
export function getCachedContext(): ProjectContext | null {
	return cachedContext;
}

/**
 * Reset the cache (e.g., on session change).
 */
export function resetContext(): void {
	cachedContext = null;
	detectionAttempted = false;
}
