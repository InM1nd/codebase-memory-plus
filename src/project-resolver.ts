import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { IndexedProject } from "./base-memory-client.js";
import type { PlusConfig, ProjectConfig } from "./config.js";

export type ResolvedProject = {
  name: string;
  root: string;
  indexed?: IndexedProject;
  configured?: ProjectConfig;
};

export function resolveProject(input: {
  projectName?: string;
  projectRoot?: string;
  indexedProjects: IndexedProject[];
  config: PlusConfig;
}): ResolvedProject | undefined {
  const configuredProjects = input.config.projects ?? [];

  if (input.projectName) {
    const configured = configuredProjects.find((project) => project.name === input.projectName);
    const indexed = input.indexedProjects.find(
      (project) =>
        project.name === input.projectName ||
        candidateProjectRoots(project).includes(normalizePath(configured?.root ?? ""))
    );

    if (configured || indexed) {
      return {
        name: configured?.name ?? indexed!.name,
        root: normalizePath(configured?.root ?? indexed!.root_path),
        indexed,
        configured
      };
    }
  }

  if (input.projectRoot) {
    const requestedRoot = normalizePath(input.projectRoot);
    const configured = configuredProjects.find(
      (project) => normalizePath(project.root) === requestedRoot
    );
    const indexed = input.indexedProjects.find(
      (project) =>
        candidateProjectRoots(project).includes(requestedRoot) ||
        project.name === pathToProjectName(requestedRoot)
    );

    return {
      name: configured?.name ?? indexed?.name ?? requestedRoot.split("/").at(-1) ?? requestedRoot,
      root: requestedRoot,
      indexed,
      configured
    };
  }

  const firstConfigured = configuredProjects[0];
  if (firstConfigured) {
    const indexed = input.indexedProjects.find(
      (project) =>
        candidateProjectRoots(project).includes(normalizePath(firstConfigured.root)) ||
        project.name === pathToProjectName(firstConfigured.root)
    );

    return {
      name: firstConfigured.name,
      root: normalizePath(firstConfigured.root),
      indexed,
      configured: firstConfigured
    };
  }

  const firstIndexed = input.indexedProjects[0];
  if (firstIndexed) {
    const [root] = candidateProjectRoots(firstIndexed);

    return {
      name: firstIndexed.name,
      root: root ?? firstIndexed.name,
      indexed: firstIndexed
    };
  }

  return undefined;
}

function normalizePath(value: string): string {
  if (!value) {
    return "";
  }

  const absolute = resolve(value);

  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function candidateProjectRoots(project: IndexedProject): string[] {
  const roots = [project.root_path, projectNameToPath(project.name)]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizePath(value));

  return Array.from(new Set(roots));
}

function pathToProjectName(value: string): string {
  return normalizePath(value).replace(/^\//, "").replace(/\//g, "-");
}

function projectNameToPath(value: string): string | undefined {
  if (value.startsWith("Users-")) {
    return `/${value.replace(/-/g, "/")}`;
  }

  if (value.startsWith("private-")) {
    return `/${value.replace(/-/g, "/")}`;
  }

  return undefined;
}
