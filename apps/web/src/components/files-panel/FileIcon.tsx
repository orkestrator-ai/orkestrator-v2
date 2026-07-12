import {
  File,
  FileCode,
  FileJson,
  FileText,
  FileType,
  Image,
  FileArchive,
  FileCog,
  Hash,
  Database,
  Globe,
  Gem,
  Coffee,
  Cog,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface FileIconProps {
  filename: string;
  className?: string;
}

interface IconConfig {
  icon: LucideIcon;
  color: string;
}

// VS Code-like color scheme for file types
const iconMap: Record<string, IconConfig> = {
  // TypeScript - Blue
  ".ts": { icon: FileCode, color: "text-blue-400" },
  ".tsx": { icon: FileCode, color: "text-blue-400" },
  ".d.ts": { icon: FileCode, color: "text-blue-300" },
  // JavaScript - Yellow
  ".js": { icon: FileCode, color: "text-yellow-400" },
  ".jsx": { icon: FileCode, color: "text-yellow-400" },
  ".mjs": { icon: FileCode, color: "text-yellow-400" },
  ".cjs": { icon: FileCode, color: "text-yellow-400" },
  // JSON - Yellow/Orange
  ".json": { icon: FileJson, color: "text-yellow-300" },
  ".jsonc": { icon: FileJson, color: "text-yellow-300" },
  // YAML - Pink/Red
  ".yaml": { icon: FileJson, color: "text-pink-400" },
  ".yml": { icon: FileJson, color: "text-pink-400" },
  // TOML - Orange
  ".toml": { icon: FileCog, color: "text-orange-400" },
  // XML - Orange
  ".xml": { icon: FileJson, color: "text-orange-400" },
  // Markdown - Blue
  ".md": { icon: FileText, color: "text-blue-300" },
  ".mdx": { icon: FileText, color: "text-blue-300" },
  // Text
  ".txt": { icon: FileText, color: "text-gray-400" },
  // CSS - Blue
  ".css": { icon: FileType, color: "text-blue-500" },
  // SCSS/Sass - Pink
  ".scss": { icon: FileType, color: "text-pink-400" },
  ".sass": { icon: FileType, color: "text-pink-400" },
  ".less": { icon: FileType, color: "text-indigo-400" },
  // Tailwind
  ".tailwind": { icon: FileType, color: "text-cyan-400" },
  // Images - Purple
  ".png": { icon: Image, color: "text-purple-400" },
  ".jpg": { icon: Image, color: "text-purple-400" },
  ".jpeg": { icon: Image, color: "text-purple-400" },
  ".gif": { icon: Image, color: "text-purple-400" },
  ".svg": { icon: Image, color: "text-orange-400" },
  ".webp": { icon: Image, color: "text-purple-400" },
  ".ico": { icon: Image, color: "text-purple-400" },
  // Rust - Orange
  ".rs": { icon: Cog, color: "text-orange-500" },
  // Python - Blue/Yellow
  ".py": { icon: FileCode, color: "text-yellow-500" },
  ".pyw": { icon: FileCode, color: "text-yellow-500" },
  ".pyi": { icon: FileCode, color: "text-yellow-300" },
  // Go - Cyan
  ".go": { icon: FileCode, color: "text-cyan-400" },
  // Java - Red
  ".java": { icon: Coffee, color: "text-red-400" },
  // C/C++ - Blue
  ".c": { icon: FileCode, color: "text-blue-400" },
  ".cpp": { icon: FileCode, color: "text-blue-500" },
  ".cc": { icon: FileCode, color: "text-blue-500" },
  ".h": { icon: FileCode, color: "text-purple-400" },
  ".hpp": { icon: FileCode, color: "text-purple-400" },
  // Swift - Orange
  ".swift": { icon: FileCode, color: "text-orange-400" },
  // Kotlin - Purple
  ".kt": { icon: FileCode, color: "text-purple-500" },
  ".kts": { icon: FileCode, color: "text-purple-500" },
  // Ruby - Red
  ".rb": { icon: Gem, color: "text-red-500" },
  ".erb": { icon: Gem, color: "text-red-400" },
  // PHP - Purple
  ".php": { icon: FileCode, color: "text-indigo-400" },
  // Shell - Green
  ".sh": { icon: Hash, color: "text-green-400" },
  ".bash": { icon: Hash, color: "text-green-400" },
  ".zsh": { icon: Hash, color: "text-green-400" },
  ".fish": { icon: Hash, color: "text-green-400" },
  // SQL - Yellow
  ".sql": { icon: Database, color: "text-yellow-400" },
  // Vue - Green
  ".vue": { icon: FileCode, color: "text-green-500" },
  // Svelte - Orange
  ".svelte": { icon: FileCode, color: "text-orange-500" },
  // HTML - Orange
  ".html": { icon: Globe, color: "text-orange-500" },
  ".htm": { icon: Globe, color: "text-orange-500" },
  // Archives - Yellow
  ".zip": { icon: FileArchive, color: "text-yellow-600" },
  ".tar": { icon: FileArchive, color: "text-yellow-600" },
  ".gz": { icon: FileArchive, color: "text-yellow-600" },
  ".rar": { icon: FileArchive, color: "text-yellow-600" },
  ".7z": { icon: FileArchive, color: "text-yellow-600" },
  // Lock files - Gray
  ".lock": { icon: FileCog, color: "text-gray-500" },
  // Env files - Yellow
  ".env": { icon: FileCog, color: "text-yellow-600" },
  // Docker - Blue
  "Dockerfile": { icon: Cog, color: "text-blue-400" },
  ".dockerfile": { icon: Cog, color: "text-blue-400" },
  // Git
  ".gitignore": { icon: FileCog, color: "text-orange-400" },
  ".gitattributes": { icon: FileCog, color: "text-orange-400" },
  // ESLint
  ".eslintrc": { icon: FileCog, color: "text-purple-400" },
  ".eslintignore": { icon: FileCog, color: "text-purple-400" },
  // Prettier
  ".prettierrc": { icon: FileCog, color: "text-pink-400" },
  ".prettierignore": { icon: FileCog, color: "text-pink-400" },
};

// Special filename matches (without extension)
const specialFiles: Record<string, IconConfig> = {
  "Dockerfile": { icon: Cog, color: "text-blue-400" },
  "Makefile": { icon: Cog, color: "text-orange-400" },
  "Cargo.toml": { icon: FileCog, color: "text-orange-500" },
  "Cargo.lock": { icon: FileCog, color: "text-gray-500" },
  "package.json": { icon: FileJson, color: "text-green-400" },
  "package-lock.json": { icon: FileJson, color: "text-gray-500" },
  "bun.lock": { icon: FileCog, color: "text-gray-500" },
  "bun.lockb": { icon: FileCog, color: "text-gray-500" },
  "tsconfig.json": { icon: FileJson, color: "text-blue-400" },
  "jsconfig.json": { icon: FileJson, color: "text-yellow-400" },
  ".gitignore": { icon: FileCog, color: "text-orange-400" },
  ".dockerignore": { icon: FileCog, color: "text-blue-400" },
  ".env": { icon: FileCog, color: "text-yellow-600" },
  ".env.local": { icon: FileCog, color: "text-yellow-600" },
  ".env.development": { icon: FileCog, color: "text-yellow-600" },
  ".env.production": { icon: FileCog, color: "text-yellow-600" },
  "README.md": { icon: FileText, color: "text-blue-400" },
  "LICENSE": { icon: FileText, color: "text-yellow-400" },
  "LICENSE.md": { icon: FileText, color: "text-yellow-400" },
  ".prettierrc": { icon: FileCog, color: "text-pink-400" },
  ".eslintrc.js": { icon: FileCog, color: "text-purple-400" },
  ".eslintrc.json": { icon: FileCog, color: "text-purple-400" },
  "tailwind.config.js": { icon: FileCog, color: "text-cyan-400" },
  "tailwind.config.ts": { icon: FileCog, color: "text-cyan-400" },
  "vite.config.ts": { icon: FileCog, color: "text-purple-500" },
  "vite.config.js": { icon: FileCog, color: "text-purple-500" },
  "next.config.js": { icon: FileCog, color: "text-white" },
  "next.config.mjs": { icon: FileCog, color: "text-white" },
};

const defaultIcon: IconConfig = { icon: File, color: "text-gray-400" };

export function FileIcon({ filename, className }: FileIconProps) {
  // Check special filenames first
  const specialConfig = specialFiles[filename];
  if (specialConfig) {
    const Icon = specialConfig.icon;
    return <Icon className={cn(specialConfig.color, className)} />;
  }

  // Check by extension
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const config = iconMap[ext] || defaultIcon;
  const Icon = config.icon;

  return <Icon className={cn(config.color, className)} />;
}
