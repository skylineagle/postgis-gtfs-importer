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

	await ensureSuccesfulImportsTableExists({
		db: client,
	});

	await client.query("BEGIN");
	try {
		logger.info(
			`obtaining exclusive lock on "${successfulImportsTableName}", so that only one import can be running`
		);
		await client.query(
			pgFormat(
				"LOCK TABLE public.%I IN EXCLUSIVE MODE NOWAIT",
				successfulImportsTableName
			)
		);

		logger.debug("checking previous imports");

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
			const prevImport = latestSuccessfulImports[i];

			if (!allSchemas.includes(prevImport.schemaName)) {
				logger.warn(
					`The "${successfulImportsTableName}" table points to a schema "${prevImport.schemaName}" which does not exist. This indicates either a bug in postgis-gtfs-importer, or that its state has been tampered with!`
				);
				latestSuccessfulImports.splice(i, 1);
				i--;
			}
		}

		{
			const schemasToRetain = determineSchemasToRetain(
				latestSuccessfulImports,
				allSchemas
			);
			ok(
				Array.isArray(schemasToRetain),
				"determineSchemasToRetain() must return an array"
			);
			logger.debug("schemas to retain: " + schemasToRetain.join(", "));
			result.retainedSchemas = schemasToRetain;

			for (const schemaName of allSchemas) {
				if (schemasToRetain.includes(schemaName)) {
					continue;
				}
				const isRecentSuccessfulImport = latestSuccessfulImports.some(
					(imp) => imp.schemaName === schemaName
				);
				if (isRecentSuccessfulImport) {
					logger.info(
						`dropping schema "${schemaName}" containing a (recent) successful import`
					);
				} else {
					logger.info(
						`dropping schema "${schemaName}" containing an older or unfinished import`
					);
				}

				try {
					await client.query(
						pgFormat("DROP SCHEMA %I CASCADE", schemaName)
					);
					result.deletedSchemas.push(schemaName);
				} catch (err) {
					if (continueOnFailureDeletingOldSchema) {
						logger.warn(
							{
								error: err,
								schemaName,
							},
							`failed to delete old schema "${schemaName}"`
						);
					} else {
						throw err;
					}
				}
				if (isRecentSuccessfulImport) {
					await removeSchemaFromLatestSuccessfulImports({
						db: client,
						schemaName,
					});
				}
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
				logger.debug(
					`adding ${files.length} files' hashes to feed_digest`
				);
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
			return result;
		}
		result.newImport = {
			schemaName,
			importedAt,
			feedDigest,
		};

		logger.debug(`creating schema "${schemaName}"`);
		await client.query(pgFormat("CREATE SCHEMA %I", schemaName));

		logger.info(`importing data into schema "${schemaName}"`);
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

		logger.info(
			`import succeeded, committing all changes to "${successfulImportsTableName}"!`
		);
		await client.query("COMMIT");
	} catch (err) {
		logger.warn("an error occured, rolling back");
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.end();
	}

	logger.debug("done!");
	return result;
};

export { importGtfsAtomically };
