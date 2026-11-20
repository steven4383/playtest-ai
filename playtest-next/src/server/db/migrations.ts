/** Schema follows section 9 of the Software Architecture Document. */
export const migrations: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE apk_builds (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        filename TEXT NOT NULL,
        package_name TEXT,
        version_name TEXT,
        version_code INTEGER,
        min_sdk INTEGER,
        target_sdk INTEGER,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        metadata_source TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_apk_sha ON apk_builds(sha256);

      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('emulator','physical','remote')),
        android_version TEXT,
        api_level INTEGER,
        avd_name TEXT,
        adb_serial TEXT,
        resolution TEXT,
        ram_mb INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 100,
        status TEXT NOT NULL DEFAULT 'offline',
        last_health_check TEXT,
        last_execution TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE campaigns (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id),
        apk_id TEXT REFERENCES apk_builds(id),
        name TEXT NOT NULL,
        requirements TEXT,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE test_cases (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        priority TEXT,
        preconditions TEXT,
        expected_result TEXT,
        source TEXT
      );

      CREATE TABLE test_steps (
        id TEXT PRIMARY KEY,
        test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        parameters TEXT
      );

      CREATE TABLE executions (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES devices(id),
        status TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error_summary TEXT
      );

      CREATE TABLE execution_steps (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        test_case_id TEXT REFERENCES test_cases(id),
        step_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        actual_result TEXT,
        duration_ms INTEGER
      );

      CREATE TABLE bugs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        severity TEXT,
        category TEXT,
        expected TEXT,
        actual TEXT,
        confidence REAL,
        reproducible INTEGER
      );

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        execution_id TEXT REFERENCES executions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        campaign_id TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
        agent_name TEXT NOT NULL,
        status TEXT NOT NULL,
        input_ref TEXT,
        output_ref TEXT,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE metric_samples (
        ts TEXT NOT NULL,
        cpu_pct REAL,
        mem_used_gb REAL,
        mem_total_gb REAL,
        gpu_pct REAL,
        vram_used_mb REAL,
        running_emulators INTEGER
      );
      CREATE INDEX idx_metric_ts ON metric_samples(ts);
    `,
  },
  {
    version: 2,
    name: 'campaign_runner',
    sql: `
      ALTER TABLE campaigns ADD COLUMN config TEXT;
      ALTER TABLE campaigns ADD COLUMN summary TEXT;
      ALTER TABLE executions ADD COLUMN device_name TEXT;
      ALTER TABLE executions ADD COLUMN serial TEXT;
      ALTER TABLE executions ADD COLUMN metrics TEXT;
      ALTER TABLE execution_steps ADD COLUMN name TEXT;
      ALTER TABLE execution_steps ADD COLUMN started_at TEXT;
      CREATE INDEX idx_exec_campaign ON executions(campaign_id);
      CREATE INDEX idx_step_exec ON execution_steps(execution_id);
      CREATE INDEX idx_artifact_exec ON artifacts(execution_id);
    `,
  },
  {
    version: 3,
    name: 'bug_reports',
    sql: `
      ALTER TABLE bugs ADD COLUMN campaign_id TEXT;
      ALTER TABLE bugs ADD COLUMN device_id TEXT;
      ALTER TABLE bugs ADD COLUMN device_name TEXT;
      ALTER TABLE bugs ADD COLUMN package_name TEXT;
      ALTER TABLE bugs ADD COLUMN app_version TEXT;
      ALTER TABLE bugs ADD COLUMN android_version TEXT;
      ALTER TABLE bugs ADD COLUMN api_level INTEGER;
      ALTER TABLE bugs ADD COLUMN signature TEXT;
      ALTER TABLE bugs ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
      ALTER TABLE bugs ADD COLUMN steps TEXT;
      ALTER TABLE bugs ADD COLUMN evidence TEXT;
      ALTER TABLE bugs ADD COLUMN excerpt TEXT;
      ALTER TABLE bugs ADD COLUMN hypothesis TEXT;
      ALTER TABLE bugs ADD COLUMN retest_campaign_id TEXT;
      ALTER TABLE bugs ADD COLUMN created_at TEXT;
      CREATE INDEX idx_bug_signature ON bugs(signature);
      CREATE INDEX idx_bug_execution ON bugs(execution_id);
      CREATE INDEX idx_bug_campaign ON bugs(campaign_id);
    `,
  },
  {
    version: 4,
    name: 'play_closed_testing',
    sql: `
      CREATE TABLE play_tests (
        package_name TEXT PRIMARY KEY,
        opt_in_url TEXT,
        required_testers INTEGER NOT NULL DEFAULT 12,
        required_days INTEGER NOT NULL DEFAULT 14,
        created_at TEXT NOT NULL
      );
      CREATE TABLE play_testers (
        id TEXT PRIMARY KEY,
        package_name TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT,
        device TEXT,
        status TEXT NOT NULL DEFAULT 'invited',
        invited_at TEXT NOT NULL,
        opted_in_at TEXT,
        left_at TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (package_name, email)
      );
      CREATE INDEX idx_play_testers_pkg ON play_testers(package_name);
    `,
  },
];
