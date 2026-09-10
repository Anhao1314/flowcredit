import { printValidation, validateAssessApi } from "./validate-assess-api.js";

printValidation(await validateAssessApi({ mode: "finch", writeExample: process.argv.includes("--write-example") }));
