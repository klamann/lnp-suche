.PHONY: fetch build test serve build-without-index install-test-deps

fetch:
	uv run fetch_transcripts.py --feed-file feed.xml --metadata-file meta.json

build:
	uv run build_index.py

test: install-test-deps
	node tests/test_search.mjs

serve: build-without-index
	npx serve dist

build-without-index:
	uv run build_index.py --skip-index

install-test-deps:
	cd tests && npm install
