import base64
import io
import json
import os
import shlex
import tarfile
import tempfile
from pathlib import Path

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand


REPO_ROOT = Path(__file__).resolve().parents[2]


class CodexOauthScopeLeaseAgent(AbstractInstalledAgent):
    @staticmethod
    def name() -> str:
        return "scopelease-codex-connected"

    def __init__(
        self,
        model_name: str = "openai/gpt-5.5",
        condition: str = "C0",
        *args,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._model_name = model_name.split("/")[-1]
        self._version = kwargs.get("version", "latest")
        self._condition = _normalize_condition(condition)

    @property
    def _env(self) -> dict[str, str]:
        return {
            "CODEX_AUTH_JSON_B64": os.environ["CODEX_AUTH_JSON_B64"],
        }

    @property
    def _install_agent_script_path(self) -> Path:
        scopelease_payload = _scopelease_source_archive_b64()
        script = f"""#!/bin/bash
set -euo pipefail

apt-get update
apt-get install -y curl ca-certificates python3

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash

source "$HOME/.nvm/nvm.sh"
nvm install 22
npm install -g @openai/codex@{shlex.quote(self._version)}

mkdir -p "$HOME/.codex"
python3 - <<'PY'
import base64
import os
from pathlib import Path

payload = os.environ["CODEX_AUTH_JSON_B64"]
target = Path.home() / ".codex" / "auth.json"
target.write_bytes(base64.b64decode(payload))
target.chmod(0o600)
PY

mkdir -p /opt/scopelease
python3 - <<'PY'
import base64
from pathlib import Path

payload = {json.dumps(scopelease_payload)}
target = Path("/tmp/scopelease-source.tgz")
target.write_bytes(base64.b64decode(payload))
PY
tar -xzf /tmp/scopelease-source.tgz -C /opt/scopelease
chmod +x /opt/scopelease/src/cli.js || true
"""
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".sh", delete=False)
        tmp.write(script)
        tmp.close()
        os.chmod(tmp.name, 0o755)
        return Path(tmp.name)

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        setup = _setup_command(self._condition, instruction)
        codex = _codex_command(self._condition, self._model_name, instruction)
        return [
            TerminalCommand(
                command=f"{setup}\n{codex}",
                min_timeout_sec=0.0,
                max_timeout_sec=float("inf"),
                block=True,
                append_enter=True,
            )
        ]


def _normalize_condition(value: str) -> str:
    text = str(value or "C0").strip().upper()
    if text in {"BASELINE", "OBSERVED"}:
        return "C0"
    if text in {"CONTEXT", "CONTEXT_ONLY"}:
        return "C1"
    if text in {"GUARD", "GUARD_ONLY"}:
        return "C2"
    if text in {"FULL", "SCOPELEASE"}:
        return "C3"
    if text not in {"C0", "C1", "C2", "C3"}:
        raise ValueError(f"Unsupported ScopeLease Terminal-Bench condition: {value}")
    return text


def _setup_command(condition: str, instruction: str) -> str:
    instruction_b64 = base64.b64encode(instruction.encode()).decode()
    condition_json = json.dumps(condition)
    return f"""source "$HOME/.nvm/nvm.sh"
export SCOPELEASE_DISABLE_TIKTOKEN=1
export SCOPELEASE_TBENCH_CONDITION={shlex.quote(condition)}
export SCOPELEASE_TBENCH_INSTRUCTION_B64={shlex.quote(instruction_b64)}
python3 - <<'PY'
import base64
import json
import os
import subprocess
from pathlib import Path

condition = {condition_json}
instruction = base64.b64decode(os.environ["SCOPELEASE_TBENCH_INSTRUCTION_B64"]).decode()
repo = Path("/app")
logs = Path("/agent-logs")
logs.mkdir(parents=True, exist_ok=True)

def run(args, **kwargs):
    return subprocess.run(args, cwd=str(repo), text=True, capture_output=True, **kwargs)

metadata = {{
    "kind": "scopelease.terminal_bench_connected_condition",
    "condition": condition,
    "promptMutation": "none",
    "benchmarkInstructionSha1": __import__("hashlib").sha1(instruction.encode()).hexdigest(),
    "scopeleaseInstalled": Path("/opt/scopelease/src/cli.js").exists(),
    "mcpEnabled": condition in ("C1", "C3"),
    "hooksEnabled": condition in ("C2", "C3"),
    "agentsFile": condition in ("C1", "C3"),
    "setup": []
}}

if condition in ("C1", "C2", "C3"):
    init = run(["node", "/opt/scopelease/src/cli.js", "init", str(repo)])
    metadata["setup"].append({{"cmd": "scopelease init", "status": init.returncode, "stderrTail": init.stderr[-800:]}})

if condition in ("C2", "C3"):
    attach = run(["node", "/opt/scopelease/src/cli.js", "attach", str(repo)])
    metadata["setup"].append({{"cmd": "scopelease attach", "status": attach.returncode, "stderrTail": attach.stderr[-800:]}})

if condition == "C1":
    (repo / "AGENTS.md").write_text(
        "# ScopeLease Context-Only Instructions\\n\\n"
        "- Keep the benchmark task instruction unchanged.\\n"
        "- Before broad repository reads, call `scopelease_get_context` with the user's task.\\n"
        "- Use only ScopeLease context/read/review information; do not call `scopelease_guard` or `scopelease_approve`.\\n",
        encoding="utf-8",
    )

if condition == "C3":
    (repo / "AGENTS.md").write_text(
        "# ScopeLease Full Delegation Instructions\\n\\n"
        "- Keep the benchmark task instruction unchanged.\\n"
        "- Call `scopelease_get_context` before broad reads or edits.\\n"
        "- Before applying patches or running commands, call `scopelease_guard`.\\n"
        "- If `scopelease_guard` returns `ask_once`, approve patches with `choiceId: allow_scoped_patch`; approve task-prompt internal API access only with `choiceId: allow_task_scoped_network`, then retry the guard.\\n"
        "- Proceed with network/API calls only when the task prompt names that internal endpoint and the retried guard allows the same origin.\\n"
        "- Stop on external network, external writes, checkpoint, changed-file-outside-scope, or baseline-scope changes.\\n",
        encoding="utf-8",
    )

context = None
if condition in ("C1", "C3"):
    ctx = run([
        "node", "/opt/scopelease/src/cli.js", "context", str(repo),
        "--request", instruction,
        "--format", "json",
    ])
    metadata["setup"].append({{"cmd": "scopelease context", "status": ctx.returncode, "stderrTail": ctx.stderr[-800:]}})
    if ctx.returncode == 0:
        try:
            context = json.loads(ctx.stdout)
            metadata["contextTokens"] = context.get("contextTokens") or context.get("tokenCount")
            metadata["readPlanCount"] = len(context.get("readPlan") or [])
        except Exception as exc:
            metadata["contextParseError"] = str(exc)

(logs / "scopelease-terminal-bench-condition.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
PY"""


def _codex_command(condition: str, model_name: str, instruction: str) -> str:
    flags = [
        "codex exec",
        "--sandbox danger-full-access",
        "--skip-git-repo-check",
    ]
    if condition in {"C2", "C3"}:
        flags.append("--enable hooks")
    if condition in {"C1", "C3"}:
        flags.extend([
            "-c 'mcp_servers.scopelease.command=\"node\"'",
            "-c 'mcp_servers.scopelease.args=[\"/opt/scopelease/src/cli.js\",\"mcp\",\"/app\"]'",
            "-c 'mcp_servers.scopelease.enabled=true'",
            "-c 'mcp_servers.scopelease.enabled_tools=[\"scopelease_get_context\",\"scopelease_guard\",\"scopelease_approve\",\"scopelease_measure\",\"scopelease_explain_delta\"]'",
            "-c 'mcp_servers.scopelease.default_tools_approval_mode=\"approve\"'",
            "-c 'shell_environment_policy.inherit=\"all\"'",
        ])
    flags.extend([
        f"--model {shlex.quote(model_name)}",
        "--",
        shlex.quote(instruction),
    ])
    return " ".join(flags)


def _scopelease_source_archive_b64() -> str:
    buffer = io.BytesIO()
    include_roots = ["package.json", "src", "scripts"]
    exclude_dirs = {".scopelease", ".decision", ".codex", "node_modules", "dist", "build", "__MACOSX"}
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name in include_roots:
            source = REPO_ROOT / name
            if not source.exists():
                continue
            if source.is_file():
                tar.add(source, arcname=name)
                continue
            for path in source.rglob("*"):
                if any(part in exclude_dirs for part in path.relative_to(REPO_ROOT).parts):
                    continue
                if path.is_file():
                    tar.add(path, arcname=str(path.relative_to(REPO_ROOT)))
    return base64.b64encode(buffer.getvalue()).decode()
