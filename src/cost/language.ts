// Return a short label for a file path that groups by file suffix rather
// than by guessed language. `.h` headers stay as ".h" instead of being
// (often-wrongly) mapped to "C" or "C++"; "TypeScript" and "JavaScript"
// likewise become ".ts"/".tsx"/".js"/etc. Honest about what we can know
// from the path alone.
//
// Files with no extension fall back to their basename if it's a known
// configuration-style name (Dockerfile, Makefile, CMakeLists.txt), else
// to "<no ext>".

const BASENAME_LABELS: Record<string, string> = {
  Dockerfile: "Dockerfile",
  Makefile: "Makefile",
  GNUmakefile: "Makefile",
  Rakefile: "Rakefile",
  Gemfile: "Gemfile",
  "CMakeLists.txt": "CMakeLists.txt",
};

export function filetypeForPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const base = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;

  const exact = BASENAME_LABELS[base];
  if (exact !== undefined) {
    return exact;
  }

  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return "<no ext>";
  }

  return base.slice(dot).toLowerCase();
}
