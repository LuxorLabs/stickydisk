const { runBuildkitMount } = require("./buildkit");

runBuildkitMount().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
