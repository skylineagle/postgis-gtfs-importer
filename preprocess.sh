gtfs_path="$1"

routes_file="$gtfs_path/routes.txt"
tmp_file="$gtfs_path/routes.txt.tmp"

if [ ! -f "$routes_file" ]; then
  echo "routes.txt not found in $gtfs_path"
  exit 1
fi

# Find which column is route_type
header=$(head -1 "$routes_file")
IFS=',' read -r -a cols <<< "$header"

idx=-1
for i in "${!cols[@]}"; do
  if [[ "${cols[$i]}" == "route_type" ]]; then
    idx=$i
    break
  fi
done

if [ $idx -eq -1 ]; then
  echo "route_type column not found in routes.txt"
  exit 1
fi

{
  echo "$header"
  tail -n +2 "$routes_file" | while IFS= read -r line; do
    # preserve correct splitting for quoted CSV
    value=$(echo "$line" | awk -v col=$(($idx + 1)) -F',' '{
      n = split($0, a, ","); 
      # naive but works with no embedded commas in values
      print a[col]
    }')
    # Only output if route_type != 8
    if [ "$value" != "8" ]; then
      echo "$line"
    fi
  done
} > "$tmp_file"

mv "$tmp_file" "$routes_file"
