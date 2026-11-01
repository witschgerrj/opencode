import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261101222904_durable_epoch_prefix",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_epoch_prefix\` (
          \`session_id\` text NOT NULL,
          \`epoch_key\` text NOT NULL,
          \`frozen_initial\` text NOT NULL,
          \`last_applied_initial\` text NOT NULL,
          \`frozen_first_reminder\` text NOT NULL,
          \`initial_iso_date\` text NOT NULL,
          \`last_applied_iso_date\` text NOT NULL,
          \`frozen_tools_json\` text NOT NULL,
          \`frozen_hooked_tools_json\` text NOT NULL,
          \`last_announced_new_tools\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_epoch_prefix_pk\` PRIMARY KEY(\`session_id\`, \`epoch_key\`),
          CONSTRAINT \`fk_session_epoch_prefix_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_turn_reminder\` (
          \`session_id\` text NOT NULL,
          \`epoch_key\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`reminder_text\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`session_turn_reminder_pk\` PRIMARY KEY(\`session_id\`, \`epoch_key\`, \`message_id\`),
          CONSTRAINT \`fk_session_turn_reminder_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_turn_reminder_session_epoch_idx\` ON \`session_turn_reminder\` (\`session_id\`,\`epoch_key\`);`,
      )
    })
  },
}

export default migration
