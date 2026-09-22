const { runMount } = require("./stickydisk");

runMount().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
