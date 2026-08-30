declare module "better-sqlite3" {
	namespace BetterSqlite3 {
		interface Options {
			readonly?: boolean;
			fileMustExist?: boolean;
			timeout?: number;
		}

		interface RunResult {
			changes: number;
			lastInsertRowid: number | bigint;
		}

		interface Statement<BindParameters extends unknown[] = unknown[], Result = unknown> {
			run: (...params: BindParameters) => RunResult;
			get: (...params: BindParameters) => Result;
			all: (...params: BindParameters) => Result[];
		}

		type Transaction<T extends (...args: never[]) => unknown> = T & {
			immediate: T;
			deferred: T;
			exclusive: T;
		};

		interface Database {
			prepare: <BindParameters extends unknown[] = unknown[], Result = unknown>(
				sql: string,
			) => Statement<BindParameters, Result>;
			exec: (sql: string) => Database;
			pragma: (source: string) => unknown;
			close: () => void;
			transaction: <T extends (...args: never[]) => unknown>(fn: T) => Transaction<T>;
		}
	}

	interface DatabaseConstructor {
		new (filename?: string | Buffer, options?: BetterSqlite3.Options): BetterSqlite3.Database;
		(filename?: string | Buffer, options?: BetterSqlite3.Options): BetterSqlite3.Database;
	}

	const BetterSqlite3: DatabaseConstructor;
	export = BetterSqlite3;
}
