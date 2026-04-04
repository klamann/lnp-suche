.PHONY: fetch build test serve install-test-deps

fetch:
	uv run fetch_transcripts.py --feed-file feed.xml --metadata-file episodes.json

build:
	uv run build_index.py

test: install-test-deps
	node tests/test_search.mjs

serve:
	npx serve dist

install-test-deps:
	cd tests && npm install
