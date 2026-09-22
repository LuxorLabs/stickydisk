const { runBuildkitFinalize } = require("./buildkit");

runBuildkitFinalize().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
