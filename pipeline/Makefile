# Local semantic-map pipeline.
# `make map` builds viewer/public/map.json from the exports in the repo root.
#
# numba/umap/hdbscan need CPython 3.9–3.12 (no 3.13+ wheels yet), so we pick a
# compatible interpreter rather than whatever `python3` happens to resolve to.
# Override with `make map PYTHON=/path/to/python3.12` if needed.

PYTHON  ?= $(shell for p in python3.12 python3.11 python3.10 python3.9 /usr/bin/python3 python3; do \
             command -v $$p >/dev/null 2>&1 && \
             $$p -c 'import sys; sys.exit(0 if (3,9)<=sys.version_info[:2]<(3,13) else 1)' 2>/dev/null && \
             { echo $$p; break; }; done)
VENV    ?= .venv
PY      := $(VENV)/bin/python
PIP     := $(VENV)/bin/pip
INPUT   ?= ..
OUT     ?= ../viewer/public

SAMPLE  ?= ../sample
N       ?= 950

.PHONY: map map-code venv install clean categories sample demo

# Full build: discover layout/edges, then reassign to the curated high-level
# taxonomy (taxonomy.py) for coherent, human-readable theme categories.
map: install
	$(PY) make_map.py --input $(INPUT) --out $(OUT)
	$(PY) categorize.py --map $(OUT)/map.json --input $(INPUT)

# Same as `map`, but also fold in your local Claude Code sessions
# (~/.claude/projects, one node per session) as a third source. Opt-in and
# fully local — map.json + conversations/ stay gitignored, nothing is uploaded.
# Override the location with `make map-code CLAUDE_CODE_ROOT=/path/to/projects`.
map-code: install
	CONSTELLATION_CLAUDE_CODE=1 $(PY) make_map.py --input $(INPUT) --out $(OUT)
	CONSTELLATION_CLAUDE_CODE=1 $(PY) categorize.py --map $(OUT)/map.json --input $(INPUT)

# Re-apply the taxonomy to an existing map.json (after editing taxonomy.py) —
# no re-embedding, no UMAP.
categories: install
	$(PY) categorize.py --map $(OUT)/map.json --input $(INPUT)

# Build without the optional Ollama naming pass.
map-offline: install
	$(PY) make_map.py --input $(INPUT) --out $(OUT) --no-ollama
	$(PY) categorize.py --map $(OUT)/map.json --input $(INPUT)

venv:
	@test -n "$(PYTHON)" || { echo "No CPython 3.9–3.12 found. Set PYTHON=/path/to/python3.12"; exit 1; }
	test -d $(VENV) || $(PYTHON) -m venv $(VENV)
	@echo "venv uses $$($(PY) --version)"

install: venv
	$(PIP) install -q --upgrade pip
	$(PIP) install -q -r requirements.txt

# Generate a synthetic Claude + ChatGPT export (no personal data needed).
# Override the conversation count with `make sample N=400`.
sample: install
	$(PY) sample_data.py $(SAMPLE) $(N)

# One-shot demo: synthesize sample exports, then build the map from them.
# `make demo` then `cd ../viewer && npm install && npm run dev`.
demo: sample
	$(MAKE) map INPUT=$(SAMPLE)

clean:
	rm -rf $(OUT)/map.json $(OUT)/conversations
