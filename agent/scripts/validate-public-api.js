import { printValidation, validateAssessApi } from "./validate-assess-api.js";

printValidation(await validateAssessApi({ mode: "public" }));
