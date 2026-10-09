// Internal git of systems (V3-30; product.yaml#decisions.D77_v3 (2)–(3)): one repository per system in the platform
// database in RF. Objects are stored as git loose objects (zlib of "<type> <size>\0<body>", byte-for-byte what
// .git/objects/xx/yyyy holds); a revision of the system is a commit on refs/heads/main (system_git_commits maps
// revision ↔ commit), brief versions are commits too. Everything goes with the system (delete_system). Forward-only.
import { type Kysely, sql } from "kysely";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS platform.system_git_objects (
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    oid text NOT NULL CHECK (oid ~ '^[0-9a-f]{40}$'),
    type text NOT NULL CHECK (type IN ('blob','tree','commit','tag')),
    size integer NOT NULL CHECK (size >= 0),
    data bytea NOT NULL,
    content_sha256 text CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (system_id, oid)
  )`,
  `CREATE INDEX IF NOT EXISTS system_git_objects_content_idx
     ON platform.system_git_objects (system_id, content_sha256) WHERE content_sha256 IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS platform.system_git_refs (
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (name ~ '^refs/(heads|tags)/[A-Za-z0-9._/-]+$'),
    oid text NOT NULL CHECK (oid ~ '^[0-9a-f]{40}$'),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (system_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS platform.system_git_commits (
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    seq integer NOT NULL CHECK (seq >= 1),
    oid text NOT NULL CHECK (oid ~ '^[0-9a-f]{40}$'),
    revision integer,
    brief_version integer CHECK (brief_version >= 1),
    subject text NOT NULL,
    author_user_id uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    committed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (system_id, seq),
    CONSTRAINT system_git_commits_oid_key UNIQUE (system_id, oid),
    FOREIGN KEY (system_id, revision) REFERENCES platform.revisions (system_id, version) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS system_git_commits_revision_idx
     ON platform.system_git_commits (system_id, revision) WHERE revision IS NOT NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
