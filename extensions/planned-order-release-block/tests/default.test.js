import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { describe, beforeAll, test, expect } from "vitest";
import { buildFunction, getFunctionInfo, loadSchema, loadInputQuery, loadFixture, validateTestAssets, runFunction } from "@shopify/shopify-function-test-helpers";
import { cartValidationsGenerateRun } from "../src/cart_validations_generate_run.js";

// Every fixture is checked three ways:
//  1. input/output match the schema and the input query,
//  2. the JavaScript gives the expected output,
//  3. the built wasm gives it too, through Shopify's function-runner. Windows
//     Smart App Control can block that unsigned runner; then step 3 is skipped.

describe("Planned-order ordering date validation", () => {
  let schema;
  let targeting;
  let functionRunnerPath;
  let wasmPath;
  let schemaPath;
  let runnerAvailable = false;

  beforeAll(async () => {
    const functionDir = path.dirname(__dirname);
    await buildFunction(functionDir);
    ({ schemaPath, functionRunnerPath, wasmPath, targeting } = await getFunctionInfo(functionDir));
    schema = await loadSchema(schemaPath);
    runnerAvailable = !spawnSync(functionRunnerPath, ["--version"]).error;
    if (!runnerAvailable) console.warn(`function-runner can't start (${functionRunnerPath}); wasm runs are skipped.`);
  }, 45000);

  const fixturesDir = path.join(__dirname, "fixtures");
  const fixtureFiles = fs
    .readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(fixturesDir, file));

  fixtureFiles.forEach((fixtureFile) => {
    const name = path.relative(fixturesDir, fixtureFile);

    test(`${name}: matches the schema and the JavaScript output`, async () => {
      const fixture = await loadFixture(fixtureFile);
      const inputQueryAST = await loadInputQuery(targeting[fixture.target].inputQueryPath);
      const validationResult = await validateTestAssets({ schema, fixture, inputQueryAST });
      expect(validationResult.inputQuery.errors).toEqual([]);
      expect(validationResult.inputFixture.errors).toEqual([]);
      expect(validationResult.outputFixture.errors).toEqual([]);
      expect(cartValidationsGenerateRun(fixture.input)).toEqual(fixture.expectedOutput);
    });

    test(`${name}: built wasm gives the same output`, async (context) => {
      if (!runnerAvailable) context.skip();
      const fixture = await loadFixture(fixtureFile);
      const inputQueryPath = targeting[fixture.target].inputQueryPath;
      const runResult = await runFunction(fixture, functionRunnerPath, wasmPath, inputQueryPath, schemaPath);
      expect(runResult.error).toBeNull();
      expect(runResult.result.output).toEqual(fixture.expectedOutput);
    }, 10000);
  });
});
