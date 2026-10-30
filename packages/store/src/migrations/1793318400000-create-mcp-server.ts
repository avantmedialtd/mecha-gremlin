import type { MigrationInterface, QueryRunner } from 'typeorm';

// As the credential migration: a class, named with its 13-digit timestamp, one statement per
// query(). The SQL is what TypeORM's schema builder generates for the mcp_server entity, whose
// unique constraints come in the order SQLite needs to report a name in use first.
export class CreateMcpServer1793318400000 implements MigrationInterface {
    name = 'CreateMcpServer1793318400000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "mcp_server" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "name" text NOT NULL, "prefix" text NOT NULL, "entry" text NOT NULL, "disabled" boolean NOT NULL, "created_at" integer NOT NULL, "updated_at" integer NOT NULL, CONSTRAINT "UQ_e3d33995069addf30320b1468a3" UNIQUE ("prefix"), CONSTRAINT "UQ_3943819bece06ee092d76857d38" UNIQUE ("name"))`,
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "mcp_server"`);
    }
}
