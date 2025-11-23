# PostGIS GTFS importer

This tool **imports [GTFS Schedule](https://gtfs.org/schedule/) data into a [PostGIS](https://postgis.net) database using [`gtfs-via-postgres`](https://github.com/public-transport/gtfs-via-postgres)**. It allows running a production service (e.g. an API) on top of programmatically re-imported data from a periodically changing GTFS feed without downtime.

Because it works as [atomically](<https://en.wikipedia.org/wiki/Atomicity_(database_systems)>) as possible with PostgreSQL, it makes the import pipeline _robust_, even if an import fails or if simultaneous imports get started.

The [`ghcr.io/mobidata-bw/postgis-gtfs-importer` Docker image](https://github.com/mobidata-bw/postgis-gtfs-importer/pkgs/container/postgis-gtfs-importer) is built automatically from this repo.

## How it works

First, the GTFS data is downloaded to, unzipped into and [cleaned](https://github.com/public-transport/gtfsclean) within `/tmp/gtfs`; You can specify a custom path using `$GTFS_TMP_DIR`.

**Each GTFS import gets its own PostgreSQL schema** called `gtfs_$unix_timestamp`. The importer keeps track of (the most recent) successful imports by – once an import has succeeded – writing its schema name into a table `latest_successful_imports` in the `public` schema within the bookkeeping database.

The newly downloaded GTFS data will only get imported if it has changed since the last import. This is determined using a [SHA-256 digest](https://en.wikipedia.org/wiki/SHA-2) of the GTFS dataset (and of the post-processing scripts, if configured, see below). The digest is stored in the `latest_successful_imports` table along with the schema name.

Before each import, it also **deletes all imports but the most recent two** successful ones; This ensures that your disk won't overflow, but also that a rollback to the previous import is always possible.

Because the entire import script runs in a [transaction](https://www.postgresql.org/docs/14/tutorial-transactions.html), and because it acquires an exclusive [lock](https://www.postgresql.org/docs/14/explicit-locking.html) on on `latest_successful_imports` in the beginning, it **should be safe to abort an import at any time**, or to (accidentally) run more than one process in parallel. Schema creation and deletion happens within the transaction, so if an import fails or is aborted, the changes will be rolled back automatically. Any unfinished schemas will be cleaned up as part of the next import (see above).

After the GTFS has been imported but before the import is marked as successful, it will run all post-processing scripts in `/etc/gtfs/postprocessing.d` (this path can be changed using `$GTFS_POSTPROCESSING_D_PATH`), if provided. This way, you can customise or augment the imported data. The execution of these scripts happens within the same transaction (in the bookkeeping DB) as the GTFS import. Files ending in `.sql` will be run using `psql`, all other files are assumed to be executable scripts. Note that the post-processing scripts also get hashed into the `$sha256_digest`, so if they change, the GTFS data will be imported again.

## Usage

### Prerequisites

You can configure access to the bookkeeping DB using the [standard `$PG…` environment variables](https://www.postgresql.org/docs/14/libpq-envars.html).

```shell
export PGDATABASE='…'
export PGUSER='…'
# …
```

_Note:_ `postgis-gtfs-importer` requires a database user/role that is [allowed](https://www.postgresql.org/docs/14/sql-alterrole.html) to create new schemas within the target database.

### Importing Data

The following commands demonstrate how to use the importer using Docker.

```shell
mkdir gtfs-tmp
docker run --rm -it \
	-v $PWD/gtfs-tmp:/tmp/gtfs \
	-e 'GTFS_DOWNLOAD_USER_AGENT=…' \
	-e 'GTFS_DOWNLOAD_URL=…' \
	ghcr.io/mobidata-bw/postgis-gtfs-importer:v5
```

_Note:_ We mount a `gtfs-tmp` directory to prevent it from re-downloading the GTFS dataset every time, even when it hasn't changed.

You can configure access to the PostgreSQL by passing the [standard `PG*` environment variables](https://www.postgresql.org/docs/14/libpq-envars.html) into the container.

If you run with `GTFSTIDY_BEFORE_IMPORT=false`, [gtfsclean](https://github.com/public-transport/gtfsclean) (a fork of [gtfstidy](https://github.com/patrickbr/gtfstidy)) will not be used.

### PostgREST role management

By default, `gtfs-to-sql` will not create PostgREST roles (`web_anon`, `postgrest`). If you need these roles created (for self-hosted PostgREST setups), set `GTFS_IMPORTER_POSTGREST=true`.

**Note:** When using Supabase, do **not** set this flag, as Supabase manages PostgREST roles and you won't have permission to reassign objects owned by them.

### writing a DSN file

If you set `$PATH_TO_DSN_FILE` to a file path, the importer will also write a [PostgreSQL key/value connection string (DSN)](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING-KEYWORD-VALUE) to that path. The DSN will include the `search_path` option set to the latest schema. Note that you must also provide `$POSTGREST_USER` & `$POSTGREST_PASSWORD` in this case.

This feature is intended to be used with [PgBouncer](https://pgbouncer.org) for "dynamic" routing of PostgreSQL clients to the schema containing the latest GTFS import.

### Updating Supabase PostgREST settings

If you're using Supabase and want to automatically update PostgREST settings to include the new schema in `db_schema` and `db_extra_search_path`, set the following environment variables:

```shell
export SUPABASE_PROJECT_REF='your-project-ref'
export SUPABASE_ACCESS_TOKEN='your-access-token'
```

After a successful import, the importer will automatically:

1. Fetch current PostgREST settings
2. Add the new schema to both `db_schema` and `db_extra_search_path` (if not already present)
3. Update the settings via Supabase API

For example, if your current settings are:

- `db_schema`: `public, graphql_public`
- `db_extra_search_path`: `public, graphql_public`

After importing schema `gtfs_1732107600`, they will become:

- `db_schema`: `public, graphql_public, gtfs_1732107600`
- `db_extra_search_path`: `public, graphql_public, gtfs_1732107600`

**Note:** If the API update fails, the import will still succeed, but you'll need to update PostgREST settings manually.

### Breaking Changes

A new major version of `postgis-gtfs-importer` _does not_ clean up imports done by the previous (major) versions. Note: Starting from v5, the importer uses schemas (named `gtfs_timestamp`) instead of separate databases. If you're upgrading from an earlier version, you'll need to manually clean up old databases created by previous versions.
