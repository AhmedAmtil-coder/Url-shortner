const handle = require("../server");

module.exports = async function handler(req, res) {
  return handle(req, res);
};
