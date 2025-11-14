#!/bin/bash

docker run --rm -it \
	-v $PWD/gtfs-tmp:/tmp/gtfs \
	-v $PWD/preprocess.sh:/etc/gtfs/preprocess.sh \
	-e 'GTFS_DOWNLOAD_USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' \
	-e 'GTFS_IMPORTER_SCHEMA=public' \
	-e 'GTFS_IMPORTER_DB_PREFIX=gtfs' \
	-e 'GTFS_DOWNLOAD_URL=https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip' \
	-e 'PGHOST=aws-1-ap-south-1.pooler.supabase.com' \
	-e 'PGPORT=6543' \
	-e 'PGDATABASE=postgres' \
	-e 'PGUSER=postgres.oxelinxseckxpdjpkpzf' \
	-e 'PGPASSWORD=autoto-sandbox' \
	ghcr.io/skylineagle/postgis-gtfs-importer:v5
