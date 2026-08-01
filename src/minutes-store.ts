import { ReviewMutationStore } from "./minutes-store-review-mutations.ts";

export * from "./minutes-store-types.ts";

/** Public facade preserving the original store API while domain logic lives in focused modules. */
export class MinutesStore extends ReviewMutationStore {}
