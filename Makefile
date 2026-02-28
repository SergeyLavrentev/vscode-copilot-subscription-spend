SHELL := /bin/bash

EXT_NAME := $(shell node -p "require('./package.json').name")
EXT_PUBLISHER := $(shell node -p "require('./package.json').publisher || ''")
EXT_ID := $(if $(EXT_PUBLISHER),$(EXT_PUBLISHER).$(EXT_NAME),$(EXT_NAME))
EXT_VERSION := $(shell node -p "require('./package.json').version")
VSIX := $(EXT_NAME)-$(shell node -p "require('./package.json').version").vsix

.PHONY: help MakeBuild build watch lint test clean package install-vsix quick-install quick-update bootstrap node-check publish preflight status bump-patch bump-minor bump-major release-local marketplace-check

help:
	@echo "Targets:"
	@echo "  make MakeBuild    - compile extension (alias)"
	@echo "  make build        - compile extension"
	@echo "  make watch        - compile in watch mode"
	@echo "  make node-check   - check local Node.js compatibility hint"
	@echo "  make status       - show local extension/package version info"
	@echo "  make marketplace-check - validate metadata/files required for Marketplace"
	@echo "  make lint         - run eslint"
	@echo "  make test         - run tests"
	@echo "  make package      - build VSIX package"
	@echo "  make install-vsix - package and install VSIX locally"
	@echo "  make quick-install - one-command local install for users"
	@echo "  make quick-update  - reinstall latest local build"
	@echo "  make bump-patch   - bump package version (no git tag)"
	@echo "  make bump-minor   - bump package version (no git tag)"
	@echo "  make bump-major   - bump package version (no git tag)"
	@echo "  make release-local - bump patch + reinstall locally"
	@echo "  make publish      - publish to VS Code Marketplace"
	@echo ""
	@echo "Required for publish:"
	@echo "  VSCE_PAT=<marketplace-token> make publish"

MakeBuild: build

build:
	npm run compile

status:
	@echo "Extension name: $(EXT_NAME)"
	@echo "Extension id: $(EXT_ID)"
	@echo "Package version: $(EXT_VERSION)"
	@echo "VSIX file: $(VSIX)"
	@echo "Installed versions (if any):"
	@code --list-extensions --show-versions | grep '^$(EXT_ID)@' || echo "  (not installed by this id)"

node-check:
	@node -e "const major=Number(process.versions.node.split('.')[0]); if (major % 2 === 1) { console.log('⚠️  Node.js '+process.version+' is an odd (non-LTS) release. Recommended: Node 22 LTS or 24+.'); } else { console.log('✅ Node.js '+process.version+' looks compatible.'); }"

marketplace-check:
	@node -e "const fs=require('fs'); const p=require('./package.json'); const required=['name','displayName','description','version','publisher']; for (const key of required){ if(!p[key] || String(p[key]).trim()===''){ console.error('Missing required package.json field: '+key); process.exit(1);} } if(!p.engines || !p.engines.vscode){ console.error('Missing required package.json field: engines.vscode'); process.exit(1);} console.log('package.json required fields: OK');"
	@test -f README.md || (echo "Missing README.md" && exit 1)
	@test -f LICENSE || (echo "Missing LICENSE" && exit 1)
	@node -e "const fs=require('fs'); const p=require('./package.json'); const icon=p.icon; if(!icon || String(icon).trim()===''){ console.error('Missing package.json field: icon'); process.exit(1);} if(!fs.existsSync(icon)){ console.error('Icon file does not exist: '+icon); process.exit(1);} const b=fs.readFileSync(icon); const pngSignature=b.length>=8 && b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47; if(!pngSignature){ console.error('Icon must be a PNG file: '+icon); process.exit(1);} const width=b.readUInt32BE(16); const height=b.readUInt32BE(20); console.log('Icon:', icon, width+'x'+height); if(width!==128 || height!==128){ console.error('Icon must be 128x128 for this project. Current: '+width+'x'+height); process.exit(1);}"
	@echo "Marketplace check: OK"

bootstrap: node-check
	@if [ -d node_modules ]; then \
		echo "Dependencies already installed. Skipping npm ci."; \
	else \
		npm ci; \
	fi

watch:
	npm run watch

lint:
	npm run lint

test:
	npm test

clean:
	rm -rf out *.vsix

package: build
	npx @vscode/vsce package --allow-missing-repository --skip-license
	@echo "Built: $(VSIX)"

install-vsix: package
	code --install-extension "$(VSIX)" --force
	@echo "Installed locally: $(VSIX)"

quick-install: bootstrap install-vsix
	@$(MAKE) --no-print-directory status
	@echo "Done. Run: Developer: Reload Window"

quick-update: install-vsix
	@$(MAKE) --no-print-directory status
	@echo "Updated. Run: Developer: Reload Window"

bump-patch:
	npm version patch --no-git-tag-version
	@echo "Version updated to $$(node -p \"require('./package.json').version\")"

bump-minor:
	npm version minor --no-git-tag-version
	@echo "Version updated to $$(node -p \"require('./package.json').version\")"

bump-major:
	npm version major --no-git-tag-version
	@echo "Version updated to $$(node -p \"require('./package.json').version\")"

release-local: bump-patch quick-update
	@echo "Local release prepared."

preflight:
	@test -n "$$VSCE_PAT" || (echo "Error: VSCE_PAT is not set" && exit 1)

publish: preflight marketplace-check build
	npx @vscode/vsce publish --allow-missing-repository --skip-license
