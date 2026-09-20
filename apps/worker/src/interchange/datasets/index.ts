/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The dataset importers (`H-032`, docs/05 §2). */

export {
  dedent,
  splitAssertions,
  splitTestMethods,
  structuralLines,
  type SplitAssertion,
  type TestMethod,
} from './assertions.js';
export { EXERCISM_LICENCE, readExercismTrack } from './exercism.js';
export { readJsonlDataset } from './jsonl.js';
export {
  DATASET_SPECS,
  JSONL_DATASETS,
  type DatasetSpec,
  type FieldMap,
  type JsonlDataset,
} from './spec.js';
