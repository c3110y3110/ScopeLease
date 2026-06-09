export const STATE_VERSION = 1;

export const DECISION_DIR = ".decision";
export const STATE_FILE = "state.json";
export const POLICY_FILE = "policies.yaml";
export const CARD_FILE = "latest-card.md";
export const CONTEXT_FILE = "context-pack.json";
export const CODEX_INPUT_FILE = "codex-input.md";
export const CONTEXT_LEDGER_FILE = "context-ledger.json";
export const MAX_INDEX_FILE_BYTES = 512 * 1024;

export const IGNORE_DIRS = new Set([
  ".decision",
  ".scopelease",
  ".codex",
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  ".turbo",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".uv",
  ".ipynb_checkpoints",
  "wandb",
  "runs",
  "logs",
  "data",
  "datasets",
  "target",
  "vendor",
  "__pycache__"
]);

export const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".rs",
  ".cs",
  ".swift",
  ".sql"
]);

export const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);
export const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".ini"]);

export const RISK_RANK = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export const RISK_LABEL = {
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical"
};

export const DEFAULT_POLICIES = `rules:
  - id: auth_path_requires_review
    description: 인증, 세션, 미들웨어 변경은 권한 흐름에 영향을 줄 수 있어 결정권자 리뷰가 필요합니다.
    risk: high
    route: senior_review
    match:
      paths:
        - "**/auth/**"
        - "**/*session*"
        - "**/*middleware*"
      keywords:
        - "token"
        - "permission"
        - "role"
    actions:
      read: allow
      propose_patch: allow
      run_tests: allow
      apply_patch: ask_once
      checkpoint: ask_once
      merge: block
      network: block
    lease:
      max_minutes: 30
      max_files: 8
      stop_when:
        - changed_file_outside_scope
        - new_high_risk_policy_hit
        - test_failure
        - external_write_requested

  - id: payment_or_billing_requires_approval
    description: 결제와 과금 변경은 금전 흐름에 직접 영향을 주므로 승인권자 확인이 필요합니다.
    risk: critical
    route: approver
    match:
      paths:
        - "**/billing/**"
        - "**/payment/**"
        - "**/*checkout*"
    actions:
      read: allow
      propose_patch: ask_once
      run_tests: allow
      apply_patch: ask_once
      checkpoint: ask_once
      merge: block
      network: block

  - id: database_migration_requires_tests
    description: 데이터베이스 마이그레이션은 되돌리기 어려우므로 리뷰와 테스트 근거가 필요합니다.
    risk: high
    route: senior_review
    match:
      paths:
        - "**/migrations/**"
        - "**/*.sql"
    actions:
      read: allow
      propose_patch: allow
      run_tests: allow
      apply_patch: ask_once
      checkpoint: ask_once
      merge: block

  - id: docs_only_can_be_logged
    description: 문서만 바뀐 경우에는 보통 추가 승인 없이 감사 기록으로 남길 수 있습니다.
    risk: low
    route: log_only
    match:
      file_types:
        - "doc"
    actions:
      read: allow
      propose_patch: allow
      apply_patch: allow
      checkpoint: ask_once
`;
