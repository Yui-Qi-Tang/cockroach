import _ from "lodash";
import { createSelector } from "reselect";

import * as protos from "src/js/protos";
import { AdminUIState } from "./state";
import { Pick } from "src/util/pick";
import { NodeStatus$Properties, MetricConstants, BytesUsed } from "src/util/proto";
import { nullOfReturnType } from "src/util/types";

/**
 * LivenessStatus is a type alias for the fully-qualified NodeLivenessStatus
 * enumeration. As an enum, it needs to be imported rather than using the 'type'
 * keyword.
 */
export import LivenessStatus = protos.cockroach.storage.NodeLivenessStatus;

/**
 * livenessNomenclature resolves a mismatch between the terms used for liveness
 * status on our Admin UI and the terms used by the backend. Examples:
 * + "Live" on the server is "Healthy" on the Admin UI
 * + "Unavailable" on the server is "Suspect" on the Admin UI
 */
export function livenessNomenclature(liveness: LivenessStatus) {
  switch (liveness) {
    case LivenessStatus.LIVE:
      return "healthy";
    case LivenessStatus.UNAVAILABLE:
      return "suspect";
    case LivenessStatus.DECOMMISSIONING:
      return "decommissioning";
    case LivenessStatus.DECOMMISSIONED:
      return "decommissioned";
    default:
      return "dead";
  }
}

// Functions to select data directly from the redux state.
const livenessesSelector = (state: AdminUIState) => state.cachedData.liveness.data;

/*
 * nodeStatusesSelector returns the current status for each node in the cluster.
 */
type NodeStatusState = Pick<AdminUIState, "cachedData", "nodes">;
export const nodeStatusesSelector = (state: NodeStatusState) => state.cachedData.nodes.data;

/*
 * selectNodeRequestStatus returns the current status of the node status request.
 */
export function selectNodeRequestStatus(state: AdminUIState) {
  return state.cachedData.nodes;
}

/**
 * livenessByNodeIDSelector returns a map from NodeID to the Liveness record for
 * that node.
 */
export const livenessByNodeIDSelector = createSelector(
  livenessesSelector,
  (livenesses) => {
    if (livenesses) {
      return _.keyBy(livenesses.livenesses, (l) => l.node_id);
    }
    return {};
  },
);

/*
 * selectLivenessRequestStatus returns the current status of the liveness request.
 */
export function selectLivenessRequestStatus(state: AdminUIState) {
  return state.cachedData.liveness;
}

/**
 * livenessStatusByNodeIDSelector returns a map from NodeID to the
 * LivenessStatus of that node.
 */
export const livenessStatusByNodeIDSelector = createSelector(
  livenessesSelector,
  (livenesses) => livenesses ? (livenesses.statuses || {}) : {},
);

/*
 * selectCommissionedNodeStatuses returns the node statuses for nodes that have
 * not been decommissioned.
 */
export const selectCommissionedNodeStatuses = createSelector(
  nodeStatusesSelector,
  livenessStatusByNodeIDSelector,
  (nodeStatuses, livenessStatuses) => {
    return _.filter(nodeStatuses, (node) => {
      const livenessStatus = livenessStatuses[`${node.desc.node_id}`];

      return _.isNil(livenessStatus) || livenessStatus !== LivenessStatus.DECOMMISSIONED;
    });
  },
);

/**
 * nodeIDsSelector returns the NodeID of all nodes currently on the cluster.
 */
const nodeIDsSelector = createSelector(
  nodeStatusesSelector,
  (nodeStatuses) => {
    return _.map(nodeStatuses, (ns) => ns.desc.node_id.toString());
  },
);

/**
 * nodeStatusByIDSelector returns a map from NodeID to a current NodeStatus$Properties.
 */
const nodeStatusByIDSelector = createSelector(
  nodeStatusesSelector,
  (nodeStatuses) => {
    const statuses: {[s: string]: NodeStatus$Properties} = {};
    _.each(nodeStatuses, (ns) => {
      statuses[ns.desc.node_id.toString()] = ns;
    });
    return statuses;
  },
);

/**
 * nodeSumsSelector returns an object with certain cluster-wide totals which are
 * used in different places in the UI.
 */
const nodeSumsSelector = createSelector(
  nodeStatusesSelector,
  livenessStatusByNodeIDSelector,
  sumNodeStats,
);

export function sumNodeStats(
  nodeStatuses: NodeStatus$Properties[],
  livenessStatusByNodeID: { [id: string]: LivenessStatus },
) {
  const result = {
    nodeCounts: {
      total: 0,
      healthy: 0,
      suspect: 0,
      dead: 0,
      decommissioned: 0,
    },
    capacityUsed: 0,
    capacityAvailable: 0,
    capacityTotal: 0,
    capacityUsable: 0,
    usedBytes: 0,
    usedMem: 0,
    totalRanges: 0,
    underReplicatedRanges: 0,
    unavailableRanges: 0,
    replicas: 0,
  };
  if (_.isArray(nodeStatuses) && _.isObject(livenessStatusByNodeID)) {
    nodeStatuses.forEach((n) => {
      const status = livenessStatusByNodeID[n.desc.node_id];
      if (status !== LivenessStatus.DECOMMISSIONED) {
        result.nodeCounts.total += 1;
      }
      switch (status) {
        case LivenessStatus.LIVE:
          result.nodeCounts.healthy++;
          break;
        case LivenessStatus.UNAVAILABLE:
        case LivenessStatus.DECOMMISSIONING:
          result.nodeCounts.suspect++;
          break;
        case LivenessStatus.DECOMMISSIONED:
          result.nodeCounts.decommissioned++;
          break;
        case LivenessStatus.DEAD:
        default:
          result.nodeCounts.dead++;
          break;
      }
      if (status !== LivenessStatus.DEAD) {
        result.capacityUsed += n.metrics[MetricConstants.usedCapacity];
        result.capacityAvailable += n.metrics[MetricConstants.availableCapacity];
        result.capacityTotal += n.metrics[MetricConstants.capacity];
        result.capacityUsable = result.capacityUsed + result.capacityAvailable;
        result.usedBytes += BytesUsed(n);
        result.usedMem += n.metrics[MetricConstants.rss];
        result.totalRanges += n.metrics[MetricConstants.ranges];
        result.underReplicatedRanges += n.metrics[MetricConstants.underReplicatedRanges];
        result.unavailableRanges += n.metrics[MetricConstants.unavailableRanges];
        result.replicas += n.metrics[MetricConstants.replicas];
      }
    });
  }
  return result;
}

export function getDisplayName(node: NodeStatus$Properties) {
  return `${node.desc.address.address_field} (n${node.desc.node_id})`;
}

// nodeDisplayNameByIDSelector provides a unique, human-readable display name
// for each node.
export const nodeDisplayNameByIDSelector = createSelector(
  nodeStatusesSelector,
  (nodeStatuses) => {
    const result: {[key: string]: string} = {};
    if (!_.isEmpty(nodeStatuses)) {
      nodeStatuses.forEach(ns => {
        result[ns.desc.node_id] = getDisplayName(ns);
      });
    }
    return result;
  },
);

/**
 * nodesSummarySelector returns a directory object containing a variety of
 * computed information based on the current nodes. This object is easy to
 * connect to components on child pages.
 */
export const nodesSummarySelector = createSelector(
  nodeStatusesSelector,
  nodeIDsSelector,
  nodeStatusByIDSelector,
  nodeSumsSelector,
  nodeDisplayNameByIDSelector,
  livenessStatusByNodeIDSelector,
  livenessByNodeIDSelector,
  (nodeStatuses, nodeIDs, nodeStatusByID, nodeSums, nodeDisplayNameByID, livenessStatusByNodeID, livenessByNodeID) => {
    return {
      nodeStatuses,
      nodeIDs,
      nodeStatusByID,
      nodeSums,
      nodeDisplayNameByID,
      livenessStatusByNodeID,
      livenessByNodeID,
    };
  },
);

const nodesSummaryType = nullOfReturnType(nodesSummarySelector);
export type NodesSummary = typeof nodesSummaryType;
