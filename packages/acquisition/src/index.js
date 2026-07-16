"use strict";

const { ACQUISITION_LIMITS } = require("./policy");
const { createLiveSourceConnector } = require("./connector");
const { createAcquisitionCache } = require("./cache");
const { searchLiveSources } = require("./coordinator");
const { createOfficialDocsConnector } = require("./connectors/official-docs");
const { createRegistryConnector } = require("./connectors/registry");
const { createGitHubConnector } = require("./connectors/github");
const { createUiCatalogConnector } = require("./connectors/ui-catalog");

module.exports = {
  ACQUISITION_LIMITS,
  createLiveSourceConnector,
  createAcquisitionCache,
  searchLiveSources,
  createOfficialDocsConnector,
  createRegistryConnector,
  createGitHubConnector,
  createUiCatalogConnector
};
