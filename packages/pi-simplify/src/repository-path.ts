export function isRepositoryRelativePath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");

  return (
    file.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split("/").includes("..")
  );
}

export function assertRepositoryRelativePaths(files: string[]): void {
  const invalidFiles = files.filter((file) => !isRepositoryRelativePath(file));
  if (invalidFiles.length === 0) return;

  throw new Error(
    `Expected repository-relative file paths without '..' segments; received: ${invalidFiles.join(", ")}`,
  );
}
