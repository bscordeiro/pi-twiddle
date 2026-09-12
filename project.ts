/**
 * Project context detection via filesystem scan.
 * Results are cached per workspace root for the current process.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface ProjectContext {
	language: string;
	runtime?: string;
	framework?: string;
	packageManager?: string;
	type: "single" | "monorepo";
}

const contextCache = new Map<string, ProjectContext | null>();
let lastWorkspaceRoot: string | undefined;

interface PackageJson {
	workspaces?: string[];
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	packageManager?: string;
}

async function readJSON<T>(filePath: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(filePath, "utf-8")) as T;
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

function detectFrameworkFromDeps(deps: Record<string, string> | undefined): string | undefined {
	if (!deps) return undefined;
	const frameworkMap: Array<[string, string]> = [
		["next", "Next.js"], ["@angular/core", "Angular"], ["nuxt", "Nuxt"],
		["svelte", "Svelte"], ["vue", "Vue"], ["react", "React"],
		["express", "Express"], ["fastify", "Fastify"], ["nestjs", "NestJS"],
		["django", "Django"], ["flask", "Flask"], ["spring-boot", "Spring Boot"],
		["quarkus", "Quarkus"], ["rails", "Rails"], ["laravel", "Laravel"],
	];
	for (const [pkg, name] of frameworkMap) {
		if (pkg in deps) return name;
	}
	return undefined;
}

function detectPackageManager(pkg: PackageJson): string | undefined {
	return pkg.packageManager?.split("@")[0];
}

function isMonorepo(pkg: PackageJson): boolean {
	return Boolean(pkg.workspaces?.length);
}

function cacheContext(root: string, context: ProjectContext): ProjectContext {
	contextCache.set(root, context);
	return context;
}

export async function detectProjectContext(workspaceRoot: string): Promise<ProjectContext | null> {
	const root = resolve(workspaceRoot);
	lastWorkspaceRoot = root;
	if (contextCache.has(root)) return contextCache.get(root) ?? null;

	const pkgJson = await readJSON<PackageJson>(join(root, "package.json"));
	if (pkgJson) {
		const hasTs = Boolean(
			pkgJson.devDependencies?.typescript ||
			pkgJson.dependencies?.typescript ||
			await fileExists(join(root, "tsconfig.json")),
		);
		return cacheContext(root, {
			language: hasTs ? "TypeScript" : "JavaScript",
			runtime: "node",
			framework: detectFrameworkFromDeps(pkgJson.dependencies) ?? detectFrameworkFromDeps(pkgJson.devDependencies),
			packageManager: detectPackageManager(pkgJson),
			type: isMonorepo(pkgJson) ? "monorepo" : "single",
		});
	}

	const markerChecks: Array<[string, ProjectContext]> = [
		["go.mod", { language: "Go", runtime: "go", type: "single" }],
		["pyproject.toml", { language: "Python", runtime: "python", type: "single" }],
		["requirements.txt", { language: "Python", runtime: "python", type: "single" }],
		["Cargo.toml", { language: "Rust", runtime: "rust", packageManager: "cargo", type: "single" }],
		["pom.xml", { language: "Java", runtime: "jvm", type: "single" }],
		["Gemfile", { language: "Ruby", runtime: "ruby", type: "single" }],
		["composer.json", { language: "PHP", runtime: "php", type: "single" }],
	];
	for (const [marker, context] of markerChecks) {
		if (await fileExists(join(root, marker))) return cacheContext(root, context);
	}

	if (await fileExists(join(root, "build.gradle")) || await fileExists(join(root, "build.gradle.kts"))) {
		return cacheContext(root, { language: "Java/Kotlin", runtime: "jvm", type: "single" });
	}

	try {
		const entries = await readdir(root);
		if (entries.some((entry) => entry.endsWith(".csproj") || entry.endsWith(".sln"))) {
			return cacheContext(root, {
				language: "C#",
				runtime: "dotnet",
				packageManager: "nuget",
				type: "single",
			});
		}
	} catch {
		// Directory access failure leaves context unknown.
	}

	return cacheContext(root, { language: "Unknown", type: "single" });
}

export function getCachedContext(workspaceRoot?: string): ProjectContext | null {
	const root = workspaceRoot ? resolve(workspaceRoot) : lastWorkspaceRoot;
	return root ? contextCache.get(root) ?? null : null;
}

export function resetContext(): void {
	contextCache.clear();
	lastWorkspaceRoot = undefined;
}
