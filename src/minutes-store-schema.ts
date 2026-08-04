import { ARTIFACT_SCHEMA } from "./minutes-store-schema-artifacts.ts";
import { CORE_SCHEMA } from "./minutes-store-schema-core.ts";
import { REVIEW_SCHEMA } from "./minutes-store-schema-review.ts";

export const MINUTES_SCHEMA = `${CORE_SCHEMA}${REVIEW_SCHEMA}${ARTIFACT_SCHEMA}`;
