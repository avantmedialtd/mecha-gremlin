import type { MigrationInterface, QueryRunner } from 'typeorm';

// TypeORM builds each migration with `new`, so this is a class, and reads its timestamp from the
// last 13 digits of its name. Each query() runs one statement: better-sqlite3 refuses a second,
// and node:sqlite, the fallback driver, drops it silently (Brief R17.1). The SQL is what TypeORM's
// schema builder generates for the credential entity.
export class CreateCredential1793232000000 implements MigrationInterface {
    name = 'CreateCredential1793232000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "credential" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "server" text NOT NULL, "url" text NOT NULL, "issuer" text NOT NULL, "client" text NOT NULL, "tokens" text NOT NULL, "discovery" text, "expires_at" integer, "needs_login" boolean NOT NULL, "lease_owner" text, "lease_until" integer, "created_at" integer NOT NULL, "updated_at" integer NOT NULL, CONSTRAINT "UQ_f2d5a93079bb8626c1c4a6732b2" UNIQUE ("server", "url", "issuer"))`,
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "credential"`);
    }
}
