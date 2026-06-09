import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const COMMON_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin"
];

export function isElectronRuntime() {
  return Boolean(process.versions?.electron);
}

export function augmentedPath(env = process.env) {
  const parts = String(env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of COMMON_BIN_DIRS) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(path.delimiter);
}

export function runtimeEnv(extra = {}, env = process.env) {
  return {
    ...env,
    PATH: augmentedPath(env),
    ...extra
  };
}

export function resolveNodeExecutable({ env = process.env, candidates = [] } = {}) {
  const configured = [
    env.SCOPELEASE_NODE_PATH,
    env.NODE,
    env.npm_node_execpath,
    ...candidates
  ].filter(Boolean);

  for (const candidate of configured) {
    if (isUsableNode(candidate, env)) return path.resolve(candidate);
  }

  if (!isElectronRuntime() && isUsableNode(process.execPath, env)) {
    return process.execPath;
  }

  const fromPath = findExecutable("node", { env });
  if (fromPath && isUsableNode(fromPath, env)) return fromPath;

  return "";
}

export function requireNodeExecutable(options = {}) {
  const nodePath = resolveNodeExecutable(options);
  if (!nodePath) {
    throw new Error(
      "Node.js executable was not found. Install Node.js or set SCOPELEASE_NODE_PATH before launching ScopeLease Desktop."
    );
  }
  return nodePath;
}

export function nodeRuntimeStatus(options = {}) {
  const nodePath = resolveNodeExecutable(options);
  if (!nodePath) {
    return {
      ok: false,
      path: "",
      version: "",
      electronRuntime: isElectronRuntime(),
      message: "Node.js not found. Set SCOPELEASE_NODE_PATH or install Node.js."
    };
  }
  const probe = spawnSync(nodePath, ["--version"], {
    encoding: "utf8",
    env: runtimeEnv({}, options.env || process.env),
    timeout: 3000
  });
  return {
    ok: probe.status === 0,
    path: nodePath,
    version: String(probe.stdout || "").trim(),
    electronRuntime: isElectronRuntime(),
    message: probe.status === 0 ? "ready" : String(probe.stderr || probe.error?.message || "node probe failed")
  };
}

export function commandStatus(command, { env = process.env } = {}) {
  const executable = findExecutable(command, { env });
  if (!executable) {
    return {
      ok: false,
      command,
      path: "",
      version: "",
      message: `${command} not found on PATH`
    };
  }
  const probe = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env: runtimeEnv({}, env),
    timeout: 5000
  });
  return {
    ok: probe.status === 0 || probe.status === 1,
    command,
    path: executable,
    version: String(probe.stdout || probe.stderr || "").trim().split("\n")[0] || "",
    message: probe.error?.message || "ready"
  };
}

export function findExecutable(command, { env = process.env } = {}) {
  const names = process.platform === "win32" && !/\.(exe|cmd|bat)$/i.test(command)
    ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
    : [command];
  const dirs = augmentedPath(env).split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return "";
}

function isUsableNode(candidate, env = process.env) {
  if (!candidate || !isExecutable(candidate)) return false;
  const probe = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    env: runtimeEnv({}, env),
    timeout: 3000
  });
  return probe.status === 0 && /^v\d+\./.test(String(probe.stdout || "").trim());
}

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
