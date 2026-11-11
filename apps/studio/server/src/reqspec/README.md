# ReqSpec and context compiler

This package is a standalone starting point for a requirements-focused AI-DLC workflow.

## Files

- `reqspec.schema.json`: JSON Schema Draft 2020-12 for the canonical requirements model.
- `context-compiler.ts`: dependency-free TypeScript compiler that creates small, task-specific AI envelopes.
- `example.reqspec.json`: sample business analyst input.

## Integration

1. Store one canonical `ReqSpec` document per initiative.
2. Validate it with any JSON Schema validator before saving or calling a model.
3. Call `compileContext(spec, { task: "find_ambiguities", requirementIds: ["FR1"] })` when AI judgment is needed.
4. Send the returned envelope to the model. Require JSON responses using the listed output operations.
5. Apply and validate returned patches in the application. Never let the model rewrite the whole ReqSpec.
6. Generate `requirements.md`, `user-stories.md`, and the coding-agent handoff deterministically from the validated ReqSpec.

## AI usage policy

The application should call the model for elicitation, ambiguity detection, acceptance-criteria suggestions, and final review only. ID assignment, validation, traceability, rendering, caching, and exports should remain deterministic.

`compileContext` filters personas, requirements, stories, confirmed decisions, and open questions to the selected task. `maxChars` provides a simple hard bound; if exceeded, optional decisions and personas are removed before the request is sent.

## Copying into AI-DLC

For an initial integration, place the files under a new directory such as `core/reqspec/` or `apps/studio/server/src/reqspec/`. The schema can be used by the business analyst UI and the TypeScript compiler can be imported by the Studio server or a workflow adapter.
