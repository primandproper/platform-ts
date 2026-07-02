# ENVIRONMENT
PWD := $(shell pwd)

# COMMANDS
PNPM := pnpm

## PREREQUISITES

.PHONY: setup
setup:
	$(PNPM) install

## FORMATTING

.PHONY: format
format:
	$(PNPM) format

.PHONY: fmt
fmt: format

.PHONY: format_check
format_check:
	$(PNPM) format:check

## LINTING

.PHONY: lint
lint:
	$(PNPM) lint

.PHONY: typecheck
typecheck:
	$(PNPM) typecheck

## VERSIONING

.PHONY: changeset
changeset:
	$(PNPM) changeset

## EXECUTION

.PHONY: build
build:
	$(PNPM) build

.PHONY: test
test:
	$(PNPM) test

.PHONY: clean
clean:
	$(PNPM) clean
