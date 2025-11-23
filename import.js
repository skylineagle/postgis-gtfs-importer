import { fileURLToPath } from "node:url";
import pgFormat from "pg-format";
import { ok } from "node:assert";
import { readdir, writeFile } from "node:fs/promises";
import {
	digestString,
	digestFile,
	pSpawn,
	formatSchemaName,
	getPgConfig,
	getPgEnv,
	connectToMetaDatabase,
	successfulImportsTableName,
	ensureSuccesfulImportsTableExists,
	queryImports,
	recordSuccessfulImport,
	removeSchemaFromLatestSuccessfulImports,
} from "./index.js";

import { createRequire } from "node:module";
import { dirname, join as pathJoin } from "node:path";
const require = createRequire(import.meta.url);
const GTFS_VIA_POSTGRES_PKG = require.resolve("gtfs-via-postgres/package.json");
const NPM_BIN_DIR = dirname(dirname(GTFS_VIA_POSTGRES_PKG)) + "/.bin";

const PATH_TO_IMPORT_SCRIPT = fileURLToPath(
	new URL("import.sh", import.meta.url).href
);
const PATH_TO_DOWNLOAD_SCRIPT = fileURLToPath(
	new URL("download.sh", import.meta.url).href
);

const importGtfsAtomically = async (cfg) => {
	const {
		logger,
		downloadScriptVerbose,
		connectDownloadScriptToStdout,
		importScriptVerbose,
		connectImportScriptToStdout,
		pathToImportScript,
		pathToDownloadScript,
		pathToDsnFile,
		gtfsDownloadUrl,
		gtfsDownloadUserAgent,
		tmpDir,
		gtfstidyBeforeImport,
		determineSchemasToRetain,
		continueOnFailureDeletingOldSchema,
		gtfsPostprocessingDPath,
		supabaseProjectRef,
		supabaseAccessToken,
	} = {
		logger: console,
		downloadScriptVerbose: true,
		connectDownloadScriptToStdout: true,
		importScriptVerbose: true,
		connectImportScriptToStdout: true,
		pathToImportScript:
			process.env.GTFS_IMPORT_SCRIPT || PATH_TO_IMPORT_SCRIPT,
		pathToDownloadScript:
			process.env.GTFS_DOWNLOAD_SCRIPT || PATH_TO_DOWNLOAD_SCRIPT,
		pathToDsnFile: process.env.GTFS_IMPORTER_DSN_FILE || null,
		gtfsDownloadUrl: null,
		gtfsDownloadUserAgent: null,
		tmpDir: process.env.GTFS_TMP_DIR || "/tmp/gtfs",
		gtfstidyBeforeImport: null,
		determineSchemasToRetain: (latestSuccessfulImports, oldSchemas) => {
			return latestSuccessfulImports
				.slice(0, 2)
				.map((_import) => _import.schemaName);
		},
		continueOnFailureDeletingOldSchema:
			process.env
				.GTFS_IMPORTED_CONTINUE_ON_FAILURE_DELETING_OLD_SCHEMA ===
			"true",
		gtfsPostprocessingDPath:
			process.env.GTFS_POSTPROCESSING_D_PATH ||
			"/etc/gtfs/postprocessing.d",
		supabaseProjectRef: process.env.SUPABASE_PROJECT_REF || null,
		supabaseAccessToken: process.env.SUPABASE_ACCESS_TOKEN || null,
		...cfg,
	};
	ok(pathToImportScript, "missing/empty cfg.pathToImportScript");
	ok(gtfsDownloadUrl, "missing/empty cfg.gtfsDownloadUrl");
	ok(gtfsDownloadUserAgent, "missing/empty cfg.gtfsDownloadUserAgent");

	const result = {
		downloadDurationMs: null,
		deletedSchemas: [],
		retainedSchemas: null,
		importSkipped: false,
		newImport: null,
		importDurationMs: null,
	};

	const zipPath = `${tmpDir}/gtfs.zip`;
	logger.info(`downloading data to "${zipPath}"`);
	const _t0Download = performance.now();
	await pSpawn(pathToDownloadScript, [], {
		stdio: [
			"inherit",
			connectDownloadScriptToStdout ? "inherit" : "ignore",
			"inherit",
		],
		env: {
			...process.env,
			GTFS_TMP_DIR: tmpDir,
			GTFS_DOWNLOAD_URL: gtfsDownloadUrl,
			GTFS_DOWNLOAD_USER_AGENT: gtfsDownloadUserAgent,
			GTFS_DOWNLOAD_VERBOSE: downloadScriptVerbose ? "true" : "false",
		},
	});
	result.downloadDurationMs = performance.now() - _t0Download;

	const pgConfig = await getPgConfig(cfg);
	const pgEnv = getPgEnv(pgConfig);

	const client = await connectToMetaDatabase(cfg);

	logger.info("Setting connection timeouts...");
	await client.query("SET statement_timeout = '0'");
	await client.query("SET lock_timeout = '10s'");
	await client.query("SET idle_in_transaction_session_timeout = '30min'");

	const {
		rows: [timeouts],
	} = await client.query(`
		SHOW statement_timeout;
	`);
	logger.info(
		`Timeouts configured: statement_timeout=${timeouts.statement_timeout}`
	);

	logger.info("Checking for idle or blocking transactions...");
	const { rows: problematicConnections } = await client.query(`
		SELECT pid, state, now() - state_change AS idle_duration, query
		FROM pg_stat_activity
		WHERE pid != pg_backend_pid()
		  AND datname = current_database()
		  AND (
		    (state = 'idle in transaction' AND now() - state_change > interval '30 seconds')
		    OR (state = 'idle' AND now() - state_change > interval '5 minutes')
		  )
	`);

	if (problematicConnections.length > 0) {
		logger.warn(
			`Found ${problematicConnections.length} problematic connection(s) that may cause lock contention:`
		);
		problematicConnections.forEach((conn) => {
			logger.warn(
				`  PID ${conn.pid} (${conn.state}, idle for ${conn.idle_duration})`
			);
		});
		logger.warn(
			"If the import fails with lock timeout, manually kill these connections:"
		);
		logger.warn(
			`  SELECT pg_terminate_backend(${problematicConnections[0].pid});`
		);
	} else {
		logger.info("No problematic connections found.");
	}

	await ensureSuccesfulImportsTableExists({
		db: client,
	});

	logger.debug("checking previous imports (before starting transaction)");
	let { latestSuccessfulImports, allSchemas } = await queryImports({
		db: client,
	});

	let prevImport = null;
	if (latestSuccessfulImports.length > 0) {
		logger.info(
			`there are ${
				latestSuccessfulImports.length
			} (most recent) successful imports recorded in the bookkeeping DB: ${latestSuccessfulImports.map(
				(imp) => imp.schemaName
			)}`
		);
		prevImport = latestSuccessfulImports[0];
	}
	logger.debug(
		"all schemas, including old/unfinished imports: " +
			allSchemas.join(", ")
	);

	for (let i = 0; i < latestSuccessfulImports.length; i++) {
		const importRecord = latestSuccessfulImports[i];

		if (!allSchemas.includes(importRecord.schemaName)) {
			logger.warn(
				`The "${successfulImportsTableName}" table points to a schema "${importRecord.schemaName}" which does not exist. This indicates either a bug in postgis-gtfs-importer, or that its state has been tampered with!`
			);
			latestSuccessfulImports.splice(i, 1);
			i--;
		}
	}

	const zipDigest = await digestFile(zipPath);
	let feedDigest = zipDigest;

	if (gtfsPostprocessingDPath !== null) {
		let files = [];
		try {
			const allFiles = await readdir(gtfsPostprocessingDPath);
			files = allFiles.filter((filename) => filename[0] !== ".");
		} catch (err) {
			if (err.code !== "ENOENT") {
				throw err;
			}
		}

		if (files.length > 0) {
			let filesDigest = "";
			logger.debug(`adding ${files.length} files' hashes to feed_digest`);
			for (const file of files) {
				const path = pathJoin(gtfsPostprocessingDPath, file);
				filesDigest += await digestFile(path);
			}
			feedDigest = digestString(feedDigest + filesDigest);
		}
	}

	const importedAt = (Date.now() / 1000) | 0;
	const schemaName = formatSchemaName({
		importedAt,
	});

	if (prevImport?.feedDigest === feedDigest) {
		result.importSkipped = true;
		logger.info("GTFS feed digest has not changed, skipping import");
		client.end();
		return result;
	}
	result.newImport = {
		schemaName,
		importedAt,
		feedDigest,
	};

	logger.info(
		`importing data into schema "${schemaName}" (schema will be created by gtfs-to-sql)`
	);

	const _importEnv = {
		...process.env,
		...pgEnv,
		PATH: NPM_BIN_DIR + ":" + process.env.PATH,
		GTFS_TMP_DIR: tmpDir,
		GTFS_IMPORTER_VERBOSE: importScriptVerbose ? "true" : "false",
		GTFS_FEED_DIGEST: feedDigest,
		GTFS_IMPORTER_SCHEMA: schemaName,
	};
	if (gtfstidyBeforeImport !== null) {
		_importEnv.GTFSTIDY_BEFORE_IMPORT = String(gtfstidyBeforeImport);
	}
	if (gtfsPostprocessingDPath !== null) {
		_importEnv.GTFS_POSTPROCESSING_D_PATH = gtfsPostprocessingDPath;
	}
	const _t0Import = performance.now();
	await pSpawn(pathToImportScript, [], {
		stdio: [
			"inherit",
			connectImportScriptToStdout ? "inherit" : "ignore",
			"inherit",
		],
		env: _importEnv,
	});
	result.importDurationMs = performance.now() - _t0Import;
	logger.debug(
		`import succeeded in ${Math.round(result.importDurationMs / 1000)}s`
	);

	logger.info("Starting transaction to record successful import...");
	await client.query("BEGIN");
	try {
		logger.info(
			`obtaining exclusive lock on "${successfulImportsTableName}"`
		);
		try {
			await client.query(
				pgFormat(
					"LOCK TABLE public.%I IN EXCLUSIVE MODE NOWAIT",
					successfulImportsTableName
				)
			);
		} catch (lockErr) {
			if (lockErr.code === "55P03") {
				logger.error(
					"Could not obtain lock - another import is recording at the same time!"
				);
				throw new Error("Could not obtain lock on bookkeeping table");
			}
			throw lockErr;
		}

		logger.info(
			`marking the import into schema "${schemaName}" as the latest`
		);
		await recordSuccessfulImport({
			db: client,
			successfulImport: {
				schemaName,
				importedAt,
				feedDigest,
			},
		});

		logger.info(
			`import succeeded, committing all changes to "${successfulImportsTableName}"!`
		);
		await client.query("COMMIT");
	} catch (err) {
		logger.warn("an error occured, rolling back");
		await client.query("ROLLBACK");

		if (err.message && err.message.includes("lock")) {
			logger.error(
				`Lock contention detected. There may be blocking transactions in the database.`
			);
			logger.error(
				`Run this query to find blockers: SELECT pid, state, query FROM pg_stat_activity WHERE state = 'idle in transaction';`
			);
		}

		throw err;
	}

	logger.info("Cleaning up old schemas (after successful import)...");
	const {
		latestSuccessfulImports: updatedImports,
		allSchemas: updatedSchemas,
	} = await queryImports({
		db: client,
	});

	const schemasToRetain = determineSchemasToRetain(
		updatedImports,
		updatedSchemas
	);
	ok(
		Array.isArray(schemasToRetain),
		"determineSchemasToRetain() must return an array"
	);
	logger.debug(
		"schemas to retain after import: " + schemasToRetain.join(", ")
	);
	result.retainedSchemas = schemasToRetain;

	for (const schemaToDelete of updatedSchemas) {
		if (schemasToRetain.includes(schemaToDelete)) {
			continue;
		}
		const isRecentSuccessfulImport = updatedImports.some(
			(imp) => imp.schemaName === schemaToDelete
		);
		if (isRecentSuccessfulImport) {
			logger.info(
				`dropping schema "${schemaToDelete}" containing a (recent) successful import`
			);
		} else {
			logger.info(
				`dropping schema "${schemaToDelete}" containing an older or unfinished import`
			);
		}

		try {
			await client.query(
				pgFormat("DROP SCHEMA %I CASCADE", schemaToDelete)
			);
			result.deletedSchemas.push(schemaToDelete);
		} catch (err) {
			if (continueOnFailureDeletingOldSchema) {
				logger.warn(
					{
						error: err,
						schemaName: schemaToDelete,
					},
					`failed to delete old schema "${schemaToDelete}"`
				);
			} else {
				throw err;
			}
		}
		if (isRecentSuccessfulImport) {
			await removeSchemaFromLatestSuccessfulImports({
				db: client,
				schemaName: schemaToDelete,
			});
		}
	}

	if (pathToDsnFile !== null) {
		const {
			PGHOST,
			PGPORT,
			PGDATABASE,
			POSTGREST_USER,
			POSTGREST_PASSWORD,
		} = process.env;
		ok(PGHOST, "missing/empty $PGHOST");
		ok(PGPORT, "missing/empty $PGPORT");
		ok(PGDATABASE, "missing/empty $PGDATABASE");
		ok(POSTGREST_USER, "missing/empty $POSTGREST_USER");
		ok(POSTGREST_PASSWORD, "missing/empty $POSTGREST_PASSWORD");

		const dsn = `gtfs=host=${PGHOST} port=${PGPORT} dbname=${PGDATABASE} options=-c search_path=${schemaName} user=${POSTGREST_USER} password=${POSTGREST_PASSWORD}`;
		const logDsn = `gtfs=host=${PGHOST} port=${PGPORT} dbname=${PGDATABASE} options=-c search_path=${schemaName} user=${POSTGREST_USER} password=${POSTGREST_PASSWORD.slice(
			0,
			2
		)}…${POSTGREST_PASSWORD.slice(-2)}`;
		logger.debug(`writing "${logDsn}" into env file ${pathToDsnFile}`);
		await writeFile(pathToDsnFile, dsn);
	}

	if (supabaseProjectRef !== null && supabaseAccessToken !== null) {
		logger.info("Updating Supabase PostgREST settings...");
		try {
			await updateSupabasePostgrestSettings({
				logger,
				projectRef: supabaseProjectRef,
				accessToken: supabaseAccessToken,
				newSchema: schemaName,
			});
			logger.info("Successfully updated Supabase PostgREST settings");
		} catch (err) {
			logger.warn(
				`Failed to update Supabase PostgREST settings: ${err.message}`
			);
			logger.warn(
				"Import succeeded, but PostgREST settings were not updated. You may need to update them manually."
			);
		}

		logger.info("Granting permissions to Supabase roles...");
		try {
			await grantSupabasePermissions({
				logger,
				db: client,
				schemaName: schemaName,
			});
			logger.info("Successfully granted permissions to Supabase roles");
		} catch (err) {
			logger.warn(
				`Failed to grant Supabase permissions: ${err.message}`
			);
			logger.warn(
				"Import succeeded, but permissions were not granted. You may need to grant them manually."
			);
		}
	}

	client.end();

	logger.debug("done!");
	return result;
};

const updateSupabasePostgrestSettings = async (cfg) => {
	const { logger, projectRef, accessToken, newSchema } = cfg;
	ok(projectRef, "missing/empty cfg.projectRef");
	ok(accessToken, "missing/empty cfg.accessToken");
	ok(newSchema, "missing/empty cfg.newSchema");

	const url = `https://api.supabase.com/v1/projects/${projectRef}/postgrest`;

	logger.debug(`Fetching current PostgREST settings from ${url}`);
	const getResponse = await fetch(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
	});

	if (!getResponse.ok) {
		const errorText = await getResponse.text();
		throw new Error(
			`Failed to fetch PostgREST settings: ${getResponse.status} ${getResponse.statusText} - ${errorText}`
		);
	}

	const currentSettings = await getResponse.json();

	if (!currentSettings.db_schema || !currentSettings.db_extra_search_path) {
		logger.debug(
			"PostgREST settings already include the new schema, skipping update"
		);
		return currentSettings;
	}

	const currentDbSchema = currentSettings.db_schema;
	const currentDbExtraSearchPath = currentSettings.db_extra_search_path;

	logger.debug(`Current db_schema: ${currentDbSchema}`);
	logger.debug(`Current db_extra_search_path: ${currentDbExtraSearchPath}`);

	const schemaList = currentDbSchema.split(",").map((s) => s.trim());
	const extraSearchPathList = currentDbExtraSearchPath
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");

	if (!schemaList.includes(newSchema)) {
		schemaList.push(newSchema);
	}
	if (!extraSearchPathList.includes(newSchema)) {
		extraSearchPathList.push(newSchema);
	}

	const updatedDbSchema = schemaList.join(", ");
	const updatedDbExtraSearchPath = extraSearchPathList.join(", ");

	logger.debug(`Updated db_schema: ${updatedDbSchema}`);
	logger.debug(`Updated db_extra_search_path: ${updatedDbExtraSearchPath}`);

	const patchResponse = await fetch(url, {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			db_schema: updatedDbSchema,
			db_extra_search_path: updatedDbExtraSearchPath,
		}),
	});

	if (!patchResponse.ok) {
		const errorText = await patchResponse.text();
		throw new Error(
			`Failed to update PostgREST settings: ${patchResponse.status} ${patchResponse.statusText} - ${errorText}`
		);
	}

	const updatedSettings = await patchResponse.json();
	logger.debug("PostgREST settings updated successfully");
	return updatedSettings;
};

const grantSupabasePermissions = async (cfg) => {
	const { logger, db, schemaName } = cfg;
	ok(db, "missing/empty cfg.db");
	ok(schemaName, "missing/empty cfg.schemaName");

	logger.debug(`Granting permissions on schema ${schemaName} to anon, authenticated, service_role`);

	await db.query(
		pgFormat("GRANT USAGE ON SCHEMA %I TO anon, authenticated, service_role", schemaName)
	);

	await db.query(
		pgFormat("GRANT ALL ON ALL TABLES IN SCHEMA %I TO anon, authenticated, service_role", schemaName)
	);

	await db.query(
		pgFormat("GRANT ALL ON ALL ROUTINES IN SCHEMA %I TO anon, authenticated, service_role", schemaName)
	);

	await db.query(
		pgFormat("GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO anon, authenticated, service_role", schemaName)
	);

	await db.query(
		pgFormat(
			"ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT ALL ON TABLES TO anon, authenticated, service_role",
			schemaName
		)
	);

	await db.query(
		pgFormat(
			"ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT ALL ON ROUTINES TO anon, authenticated, service_role",
			schemaName
		)
	);

	await db.query(
		pgFormat(
			"ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT ALL ON SEQUENCES TO anon, authenticated, service_role",
			schemaName
		)
	);

	logger.debug("Permissions granted successfully");
};

export { importGtfsAtomically };
