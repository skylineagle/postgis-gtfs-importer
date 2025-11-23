#!/bin/bash

# docker run --rm -it \
# 	-v $PWD/gtfs-tmp:/tmp/gtfs \
# 	-v $PWD/preprocess.sh:/etc/gtfs/preprocess.sh \
# 	-e 'GTFS_DOWNLOAD_USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' \
# 	-e 'GTFS_DOWNLOAD_URL=https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip' \
# 	-e 'PGHOST=aws-1-ap-southeast-1.pooler.supabase.com' \
# 	-e 'PGPORT=6543' \
# 	-e 'PGDATABASE=postgres' \
# 	-e 'PGUSER=postgres.qjlexresdrmjmdhoctfw' \
# 	-e 'PGPASSWORD=9GGoKjjVzkh1U2o' \
# 	-e "PGOPTIONS=-c statement_timeout=0 -c lock_timeout=10s -c idle_in_transaction_session_timeout=30min" \
# 	gtfs-importer-n
# 	# ghcr.io/skylineagle/postgis-gtfs-importer:v5

docker run --rm -it \
	-v $PWD/gtfs-tmp:/tmp/gtfs \
	-v $PWD/preprocess.sh:/etc/gtfs/preprocess.sh \
	-e 'GTFS_DOWNLOAD_USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' \
	-e 'GTFS_DOWNLOAD_URL=https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip' \
	-e 'SUPABASE_PROJECT_REF=qjlexresdrmjmdhoctfw' \
	-e 'SUPABASE_ACCESS_TOKEN=sbp_46ec5837b530f70a61c275395d552be291f57e1b' \
	-e 'PGHOST=aws-1-ap-southeast-1.pooler.supabase.com' \
	-e 'PGPORT=6543' \
	-e 'PGDATABASE=postgres' \
	-e 'PGUSER=postgres.qjlexresdrmjmdhoctfw' \
	-e 'PGPASSWORD=9GGoKjjVzkh1U2o' \
	-e "PGOPTIONS=-c statement_timeout=0 -c lock_timeout=10s -c idle_in_transaction_session_timeout=30min" \
	gtfs-importer-n
	# ghcr.io/skylineagle/postgis-gtfs-importer:v5
