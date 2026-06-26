// Map file extension (lowercased, leading dot included) to a display language.
// Unknown extensions fall through to a synthetic "Other" bucket so they don't
// inflate language-specific totals.

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".pyi": "Python",
  ".rb": "Ruby",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".scala": "Scala",
  ".swift": "Swift",
  ".m": "Objective-C",
  ".mm": "Objective-C++",
  ".c": "C",
  ".h": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".cxx": "C++",
  ".hpp": "C++",
  ".hh": "C++",
  ".hxx": "C++",
  ".cs": "C#",
  ".fs": "F#",
  ".php": "PHP",
  ".pl": "Perl",
  ".pm": "Perl",
  ".lua": "Lua",
  ".r": "R",
  ".jl": "Julia",
  ".dart": "Dart",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".erl": "Erlang",
  ".hrl": "Erlang",
  ".clj": "Clojure",
  ".cljs": "Clojure",
  ".hs": "Haskell",
  ".ml": "OCaml",
  ".mli": "OCaml",
  ".el": "Emacs Lisp",
  ".lisp": "Lisp",
  ".scm": "Scheme",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
  ".fish": "Shell",
  ".ps1": "PowerShell",
  ".sql": "SQL",
  ".html": "HTML",
  ".htm": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".sass": "Sass",
  ".less": "Less",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".md": "Markdown",
  ".mdx": "Markdown",
  ".rst": "reStructuredText",
  ".tex": "TeX",
  ".json": "JSON",
  ".jsonc": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".toml": "TOML",
  ".xml": "XML",
  ".proto": "Protobuf",
  ".graphql": "GraphQL",
  ".gql": "GraphQL",
  ".dockerfile": "Dockerfile",
  ".tf": "Terraform",
  ".hcl": "HCL",
  ".vim": "Vim Script",
  ".zig": "Zig",
  ".nim": "Nim",
  ".cr": "Crystal",
};

const BASENAME_TO_LANG: Record<string, string> = {
  Dockerfile: "Dockerfile",
  Makefile: "Makefile",
  GNUmakefile: "Makefile",
  Rakefile: "Ruby",
  Gemfile: "Ruby",
  "CMakeLists.txt": "CMake",
};

export function languageForPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const base = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;

  const exactMatch = BASENAME_TO_LANG[base];
  if (exactMatch !== undefined) {
    return exactMatch;
  }

  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return "Other";
  }
  const ext = base.slice(dot).toLowerCase();
  return EXT_TO_LANG[ext] ?? "Other";
}
