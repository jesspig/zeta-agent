import { test } from "bun:test";
import { backendContractTests } from "./backend.contract.spec";
import { OpenTuiBackend } from "./backend-opentui";

backendContractTests("OpenTuiBackend", () => new OpenTuiBackend());
