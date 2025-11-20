#!/bin/bash

docker run --rm -it \
	-v $PWD/gtfs-tmp:/tmp/gtfs \
	-v $PWD/preprocess.sh:/etc/gtfs/preprocess.sh \
	-e 'GTFS_DOWNLOAD_USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' \
	-e 'GTFS_DOWNLOAD_URL=https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip' \
	-e 'PGHOST=aws-1-ap-northeast-2.pooler.supabase.com' \
	-e 'PGPORT=6543' \
	-e 'PGDATABASE=postgres' \
	-e 'PGUSER=postgres.iwrvcwhmozqoshvnvadl' \
	-e 'PGPASSWORD=autoto-sandbox' \
	-e "PGOPTIONS=-c statement_timeout=5min -c lock_timeout=10s -c idle_in_transaction_session_timeout=5min" \
	gtfs-importer-n
	# ghcr.io/skylineagle/postgis-gtfs-importer:v5
