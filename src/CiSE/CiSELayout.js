/**
 * This class implements a Circular Spring Embedder (CiSE) layout algortithm.
 * The algorithm is used for layout of clustered nodes where nodes in each
 * cluster is drawn around a circle. The basic steps of the algorithm follows:
 * - Step 1: each cluster is laid out with AVSDF circular layout algorithm;
 * - Step 2: cluster graph (quotient graph of the clustered graph, where nodes
 *   correspond to clusters and edges correspond to inter-cluster edges) is laid
 *   out with a spring embedder to determine the initial layout;
 * - Steps 3-5: the cluster graph is laid out with a modified spring embedder,
 *   where the nodes corresponding to clusters are also allowed to rotate,
 *   indirectly affecting the layout of the nodes inside the clusters. In Step
 *   3, we allow flipping of clusters, whereas in Step 4, we allow swapping of
 *   neighboring node pairs in a cluster to improve inter-cluster edge crossings
 *   without increasing intra-cluster crossings.
 *
 *   The input view aspect of GraphManager is inherited from Java version of
 *   CiSE (Chilay) as a side effect. Ignore any references to 'view' elements.
 *
 *
 * Copyright: i-Vis Research Group, Bilkent University, 2007 - present
 */

// -----------------------------------------------------------------------------
// Section: Initializations
// -----------------------------------------------------------------------------

let Layout = require('avsdf-base').layoutBase.FDLayout;
let HashMap = require('avsdf-base').layoutBase.HashMap;
const PointD = require('avsdf-base').layoutBase.PointD;
const DimensionD = require('avsdf-base').layoutBase.DimensionD;

const CiSEConstants = require('./CiSEConstants');
const CiSEGraphManager = require('./CiSEGraphManager');
const CiSECircle = require('./CiSECircle');
const CiSENode = require('./CiSENode');
const CiSEEdge = require('./CiSEEdge');

let AVSDFConstants = require('avsdf-base').AVSDFConstants;
const AVSDFLayout = require('avsdf-base').AVSDFLayout;

const CoSELayout = require('cose-base').CoSELayout;
const CoSEConstants = require('cose-base').CoSEConstants;


// Constructor
function CiSELayout()
{
    Layout.call(this);

    /**
     * Separation of the nodes on each circle customizable by the user
     */
    this.nodeSeparation = CiSEConstants.DEFAULT_NODE_SEPARATION;

    /**
     * Ideal edge length coefficient for inter-cluster edges
     */
    this.idealInterClusterEdgeLengthCoefficient = CiSEConstants.DEFAULT_IDEAL_INTER_CLUSTER_EDGE_LENGTH_COEFF;

    /**
     * Decides whether pull on-circle nodes inside of the circle.
     */
    this.allowNodesInsideCircle = CiSEConstants.DEFAULT_ALLOW_NODES_INSIDE_CIRCLE;

    /**
     * Max percentage of the nodes in a circle that can move inside the circle
     */
    this.maxRatioOfNodesInsideCircle = CiSEConstants.DEFAULT_MAX_RATIO_OF_NODES_INSIDE_CIRCLE;

    /**
     * Current step of the layout process
     */
    this.step = CiSELayout.STEP_NOT_STARTED;

    /**
     * Current phase of current step
     */
    this.phase = CiSELayout.PHASE_NOT_STARTED;

    /**
     * Holds the set of pairs swapped in the last swap phase.
     */
    this.swappedPairsInLastIteration = {};

    this.oldTotalDisplacement = 0.0;

    // -----------------------------------------------------------------------------
    // Section: Class constants
    // -----------------------------------------------------------------------------
    /**
     * Steps of layout
     */
    this.STEP_NOT_STARTED = 0;
    this.STEP_1 = 1;
    this.STEP_2 = 2;
    this.STEP_3 = 3;
    this.STEP_4 = 4;
    this.STEP_5 = 5;

    this.iterations = 0;

    /**
     * Phases of a step
     */
    this.PHASE_NOT_STARTED = 0;
    this.PHASE_SWAP_PREPERATION = 1;
    this.PHASE_PERFORM_SWAP = 2;
    this.PHASE_OTHER = 3;
}

CiSELayout.prototype = Object.create(Layout.prototype);

for (let property in Layout)
{
    CiSELayout[property] = Layout[property];
}

/**
 * This method creates a new graph manager associated with this layout.
 */
CiSELayout.prototype.newGraphManager = function(){
    this.graphManager = new CiSEGraphManager(this);
    return this.graphManager;
};

/**
 * This method creates a new graph(CiSECircle) associated with the input view graph.
 */
CiSELayout.prototype.newCircleLGraph = function(vGraph){
    return new CiSECircle(null, this.graphManager, vGraph);
};

/**
 * This method creates a new node associated with the input view node.
 */
CiSELayout.prototype.newNode = function(loc, size)
{
    return new CiSENode(this.graphManager, loc, size, null);
};

/**
 * This method creates a new on-circle CiSE node associated with the input
 * view node.
 */
CiSELayout.prototype.newCiSEOnCircleNode = function(loc, size)
{
    let newNode = this.newNode(loc, size);
    newNode.setAsOnCircleNode();

    return newNode;
};

/**
 * This method creates a new edge associated with the input view edge.
 */
CiSELayout.prototype.newEdge = function(source,target, vEdge)
{
    return new CiSEEdge(source, target, vEdge);
};

/**
 * This method establishes the GraphManager object related to this layout. Each compound(LGraph) is CiSECircle except
 * for the root.
 * @param nodes: All nodes in the graph
 * @param edges: All edges in the graph
 * @param clusters: Array of cluster ID arrays. Each array represents a cluster where ID ∈ {0,1,2,..,n(# of clusters)}
 *
 * Notes:
 * -> For unclustered nodes, their clusterID is -1.
 * -> CiSENode that corresponds to a cluster has no ID property.
 */
CiSELayout.prototype.convertToClusteredGraph = function(nodes, edges, clusters){

    let self = this;
    let idToLNode = {};
    let rootGraph = this.graphManager.getRoot();

    // Firstly, lets create a HashMap to get node properties easier
    let idToCytoscapeNode = new HashMap();
    for(let i = 0; i < nodes.length; i++){
        idToCytoscapeNode.put(nodes[i].data('id'), nodes[i]);
    }

    // lets add the nodes in clusters to the GraphManager
    for(let i = 0; i < clusters.length; i++)
    {
        // Create a CiSENode for the cluster
        let clusterNode = this.newNode(null);

        // ClusterID ∈ {0,1,2,..,n(# of clusters)}
        clusterNode.setClusterId(i);

        // Add it rootGraph
        rootGraph.add(clusterNode);

        // Create the associated Circle representing the cluster and link them together
        let circle = this.newCircleLGraph(null);
        this.graphManager.add(circle, clusterNode);

        // Set bigger margins so clusters are spaced out nicely
        circle.margin = circle.margin + 15;

        // Move each node of the cluster into this circle
        clusters[i].forEach(function(nodeID){
            let cytoNode = idToCytoscapeNode.get(nodeID);
            let dimensions = cytoNode.layoutDimensions({
                nodeDimensionsIncludeLabels: false
            });
            // Adding a node into the circle
            let ciseNode = self.newCiSEOnCircleNode(new PointD(cytoNode.position('x') - dimensions.w / 2,
                cytoNode.position('y') - dimensions.h / 2),
                new DimensionD(parseFloat(dimensions.w), parseFloat(dimensions.h)));
            ciseNode.setId(nodeID);
            ciseNode.setClusterId(i);
            circle.getOnCircleNodes().push(ciseNode);
            circle.add(ciseNode);

            // Initially all on-circle nodes are assumed to be in-nodes
            circle.getInNodes().push(ciseNode);

            // Map the node
            idToLNode[ciseNode.getId()] = ciseNode;
        });
    }

    // Now, add unclustered nodes to the GraphManager
    for(let i = 0; i < nodes.length; i++) {
        let clustered = false;

        clusters.forEach(cluster => {
            if( cluster.includes( nodes[i].data('id') ))
                clustered = true;
        });

        if(!clustered){
            let cytoNode = nodes[i];
            let dimensions = cytoNode.layoutDimensions({
                nodeDimensionsIncludeLabels: false
            });
            let CiSENode = this.newNode(new PointD(cytoNode.position('x') - dimensions.w / 2,
                cytoNode.position('y') - dimensions.h / 2),
                new DimensionD(parseFloat(dimensions.w), parseFloat(dimensions.h)));
            CiSENode.setClusterId(-1);
            CiSENode.setId( nodes[i].data('id') );
            rootGraph.add(CiSENode);

            // Map the node
            idToLNode[CiSENode.getId()] = CiSENode;
        }
    }

    // Lastly, add all edges
    for(let i = 0; i < edges.length; i++) {
        let e = edges[i];
        let sourceNode = idToLNode[e.data("source")];
        let targetNode = idToLNode[e.data("target")];
        let sourceClusterID = sourceNode.getClusterId();
        let targetClusterID = targetNode.getClusterId();

        if(sourceNode === targetNode)
            continue;

        let ciseEdge = self.newEdge(sourceNode, targetNode, null);

        // Edge is intracluster
        // Remember: If source or target is unclustered then edge is Not intracluster
        if(sourceClusterID === targetClusterID && sourceClusterID !== -1 && targetClusterID !== -1){
            ciseEdge.isIntraCluster = true;
            ciseEdge.getSource().getOwner().add(ciseEdge, ciseEdge.getSource(), ciseEdge.getTarget());
        }
        else{
            ciseEdge.isIntraCluster = false;
            this.graphManager.add(ciseEdge, ciseEdge.getSource(), ciseEdge.getTarget());
        }
    }

    // Populate the references of GraphManager
    let onCircleNodes = [];
    let nonOnCircleNodes = [];
    let allNodes = this.graphManager.getAllNodes();
    for(let i = 0; i < allNodes.length; i++){
        if(allNodes[i].getOnCircleNodeExt()){
            onCircleNodes.push(allNodes[i]);
        }
        else{
            nonOnCircleNodes.push(allNodes[i]);
        }
    }

    this.graphManager.setOnCircleNodes(onCircleNodes);
    this.graphManager.setNonOnCircleNodes(nonOnCircleNodes);

    // Deternine out-nodes of each circle
    this.graphManager.edges.forEach(function(e){
        let sourceNode = e.getSource();
        let targetNode = e.getTarget();
        let sourceClusterID = sourceNode.getClusterId();
        let targetClusterID = targetNode.getClusterId();

        // If an on-circle node is an out-node, then remove it from the
        // in-node list and add it to out-node list of the associated
        // circle. Notice that one or two ends of an inter-graph edge will
        // be out-node(s).
        if(sourceClusterID !== -1){
            let circle = sourceNode.getOwner();

            // Make sure it has not been already moved to the out node list
            let index = circle.getInNodes().indexOf(sourceNode);
            if( index > -1){
                circle.getInNodes().splice(index, 1);
                circle.getOutNodes().push(sourceNode);
            }
        }

        if(targetClusterID !== -1){
            let circle = targetNode.getOwner();

            // Make sure it has not been already moved to the out node list
            let index = circle.getInNodes().indexOf(targetNode);
            if( index > -1){
                circle.getInNodes().splice(index, 1);
                circle.getOutNodes().push(targetNode);
            }
        }
    });

    return idToLNode;
};

/**
 * This method runs AVSDF layout for each cluster.
 */
CiSELayout.prototype.doStep1 = function(){
    this.step = CiSELayout.STEP_1;
    this.phase = CiSELayout.PHASE_OTHER;

    // Mapping for transferring positions and dimensions back
    let ciseToAvsdf = new HashMap();

    let allGraphs = this.graphManager.getGraphs();
    for(let i = 0; i < allGraphs.length; i++){
        let graph = allGraphs[i];

        // Skip the root graph which is a normal LGraph
        if(graph instanceof CiSECircle) {
            // Create the AVSDF layout objects
            AVSDFConstants.DEFAULT_NODE_SEPARATION = this.nodeSeparation;
            let avsdfLayout = new AVSDFLayout();
            let avsdfCircle = avsdfLayout.graphManager.addRoot();
            let clusteredNodes = graph.getOnCircleNodes();

            // Create corresponding AVSDF nodes in current cluster
            for (let i = 0; i < clusteredNodes.length; i++) {
                let ciseOnCircleNode = clusteredNodes[i];

                let avsdfNode = avsdfLayout.newNode(null);
                let loc = ciseOnCircleNode.getLocation();
                avsdfNode.setLocation(loc.x, loc.y);
                avsdfNode.setWidth(ciseOnCircleNode.getWidth());
                avsdfNode.setHeight(ciseOnCircleNode.getHeight());
                avsdfCircle.add(avsdfNode);

                ciseToAvsdf.put(ciseOnCircleNode, avsdfNode);
            }

            // For each edge, create a corresponding AVSDF edge if its both ends
            // are in this cluster.
            let allEdges = this.getAllEdges();
            for(let i = 0; i < allEdges.length; i++) {
                let edge = allEdges[i];

                if(clusteredNodes.includes( edge.getSource() ) && clusteredNodes.includes( edge.getTarget() )){
                    let avsdfSource = ciseToAvsdf.get( edge.getSource() );
                    let avsdfTarget = ciseToAvsdf.get( edge.getTarget() );
                    let avsdfEdge = avsdfLayout.newEdge("");

                    avsdfCircle.add(avsdfEdge, avsdfSource, avsdfTarget);
                }
            }

            // Run AVSDF layout
            avsdfLayout.layout();

            // Do post-processing
            let sortedByDegreeList = avsdfLayout.initPostProcess();
            for(let i = 0; i < sortedByDegreeList.length; i++){
                avsdfLayout.oneStepPostProcess(sortedByDegreeList[i]);
            }
            avsdfLayout.updateNodeAngles();
            avsdfLayout.updateNodeCoordinates();

            // Reflect changes back to CiSENode's
            for(let i = 0; i < clusteredNodes.length; i++){
                let ciseOnCircleNode = clusteredNodes[i];
                let avsdfNode = ciseToAvsdf.get(ciseOnCircleNode);
                let loc = avsdfNode.getLocation();
                ciseOnCircleNode.setLocation(loc.x, loc.y);
                ciseOnCircleNode.getOnCircleNodeExt().setIndex(avsdfNode.getIndex());
                ciseOnCircleNode.getOnCircleNodeExt().setAngle(avsdfNode.getAngle());
            }

            // Sort nodes of this ciseCircle according to circle indexes of
            // ciseOnCircleNodes.
            clusteredNodes.sort(function(a, b) {
                return a.getOnCircleNodeExt().getIndex() - b.getOnCircleNodeExt().getIndex();
            });

            // Assign width and height of the AVSDF circle containing the nodes
            // above to the corresponding cise-circle.
            if (avsdfCircle.getNodes().length > 0)
            {
                let parentCiSE = graph.getParent();
                let parentAVSDF = avsdfCircle.getParent();
                parentCiSE.setLocation(parentAVSDF.getLocation().x, parentAVSDF.getLocation().y);
                graph.setRadius(avsdfCircle.getRadius());
                graph.calculateParentNodeDimension();
            }

        }
    }
};

/**
 * This method runs a spring embedder on the cluster-graph (quotient graph
 * of the clustered graph) to determine initial layout.
 */
CiSELayout.prototype.doStep2 = function(){
    this.step = CiSELayout.STEP_2;
    this.phase = CiSELayout.PHASE_OTHER;
    let newCoSENodes = [];
    let newCoSEEdges = [];

    // Used for holding conversion mapping between cise and cose nodes.
    let ciseNodeToCoseNode = new HashMap();

    // Used for reverse mapping between cose and cise edges while sorting
    // incident edges.
    let coseEdgeToCiseEdges = new HashMap();

    // Create a CoSE layout object
    let coseLayout = new CoSELayout();
    coseLayout.isSubLayout = false;
    coseLayout.useMultiLevelScaling = false;
    coseLayout.useFRGridVariant = true;
    coseLayout.springConstant *= 1.5;

    let gm = coseLayout.newGraphManager();
    let coseRoot = gm.addRoot();

    // Traverse through all nodes and create new CoSENode's.
    // !WARNING! = REMEMBER to set unique "id" properties to CoSENodes!!!!
    let nonOnCircleNodes = this.graphManager.getNonOnCircleNodes();
    for (let i = 0; i < nonOnCircleNodes.length; i++){
        let ciseNode = nonOnCircleNodes[i];

        let newNode = coseLayout.newNode(null);
        let loc = ciseNode.getLocation();
        newNode.setLocation(loc.x, loc.y);
        newNode.setWidth(ciseNode.getWidth());
        newNode.setHeight(ciseNode.getHeight());

        // Set nodes corresponding to circles to be larger than original, so
        // inter-cluster edges end up longer.
        if (ciseNode.getChild() != null)
        {
            newNode.setWidth(1.2 * newNode.getWidth());
            newNode.setHeight(1.2 * newNode.getHeight());
        }

        // !WARNING! = CoSE EXPECTS "id" PROPERTY IMPLICITLY, REMOVING IT WILL CAUSE TILING TO OCCUR ON THE WHOLE GRAPH
        newNode.id = i;

        coseRoot.add(newNode);
        newCoSENodes.push(newNode);
        ciseNodeToCoseNode.put(ciseNode, newNode);
    }

    // Used for preventing duplicate edge creation between two cose nodes
    let nodePairs = new Array(newCoSENodes.length);
    for(let i = 0; i < nodePairs.length; i++){
        nodePairs[i] = new Array(newCoSENodes.length);
    }

    // Traverse through edges and create cose edges for inter-cluster ones.
    let allEdges = this.graphManager.getAllEdges();
    for (let i = 0; i < allEdges.length; i++ ){
        let ciseEdge = allEdges[i];
        let sourceCise = ciseEdge.getSource();
        let targetCise = ciseEdge.getTarget();

        // Determine source and target nodes for current edge
        if (sourceCise.getOnCircleNodeExt() != null){
            // Source node is an on-circle node, take its parent as source node
            sourceCise = ciseEdge.getSource().getOwner().getParent();
        }
        if (targetCise.getOnCircleNodeExt() != null){
            // Target node is an on-circle node, take its parent as target node
            targetCise = ciseEdge.getTarget().getOwner().getParent();
        }

        let sourceCose = ciseNodeToCoseNode.get(sourceCise);
        let targetCose = ciseNodeToCoseNode.get(targetCise);
        let sourceIndex = newCoSENodes.indexOf(sourceCose);
        let targetIndex = newCoSENodes.indexOf(targetCose);

        let newEdge;
        if (sourceIndex !== targetIndex){
            // Make sure it's an inter-cluster edge

            if (nodePairs[sourceIndex][targetIndex] == null &&
                nodePairs[targetIndex][sourceIndex] == null)
            {
                newEdge = coseLayout.newEdge(null);
                coseRoot.add(newEdge, sourceCose, targetCose);
                newCoSEEdges.push(newEdge);

                coseEdgeToCiseEdges.put(newEdge,[]);

                nodePairs[sourceIndex][targetIndex] = newEdge;
                nodePairs[targetIndex][sourceIndex] = newEdge;
            }
            else
            {
                newEdge =  nodePairs[sourceIndex][targetIndex];
            }

            coseEdgeToCiseEdges.get(newEdge).push(ciseEdge);
        }
    }

    //this.reorderIncidentEdges(ciseNodeToCoseNode, coseEdgeToCiseEdges);

    // Run CoSELayout
    coseLayout.runLayout();

    // Reflect changes back to cise nodes
    // First update all non-on-circle nodes.
    for (let i = 0; i < nonOnCircleNodes.length; i++)
    {
        let ciseNode = nonOnCircleNodes[i];
        let coseNode = ciseNodeToCoseNode.get(ciseNode);
        let loc = coseNode.getLocation();
        ciseNode.setLocation(loc.x, loc.y);
    }

    // Then update all cise on-circle nodes, since their parents have
    // changed location.

    let onCircleNodes = this.graphManager.getOnCircleNodes();

    for (let i = 0; i < onCircleNodes.length; i++)
    {
        let ciseNode = onCircleNodes[i];
        let loc = ciseNode.getLocation();
        let parentLoc = ciseNode.getOwner().getParent().getLocation();
        ciseNode.setLocation(loc.x + parentLoc.x, loc.y + parentLoc.y);
    }

};

/**
 * This method sorts incident lists of cose nodes created earlier according
 * to node ordering inside corresponding cise circles, if any. For each cose
 * edge we have one or possibly more cise edges. Let's look up their indices
 * and somehow do a smart calculation of their average. So if this cluster A
 * is connected to cluster B via on-circle nodes indexed at 3, 6, and 12,
 * then we may imagine that cluster B should be aligned with the node
 * indexed at 7 [=(3+6+12)/3]. The input parameters reference the hash maps
 * maintaining correspondence between cise and cose nodes (1-1) and cose and
 * cise edges (1-many), respectively.
 **/
CiSELayout.prototype.reorderIncidentEdges = function(ciseNodeToCoseNode, coseEdgeToCiseEdges){

    let nonOnCircleNodes = this.graphManager.getNonOnCircleNodes();

    for (let i = 0; i < nonOnCircleNodes.length; i++)
    {
        if (nonOnCircleNodes[i].getChild() == null)
        {
            continue;
        }

        let ciseCircle = nonOnCircleNodes[i].getChild();
        let mod = ciseCircle.getOnCircleNodes().length;
        let coseNode = ciseNodeToCoseNode.get(ciseCircle.getParent());
        let incidentCoseEdges =  coseNode.getEdges();
        let indexMapping = new HashMap();

        for (let j = 0; j < incidentCoseEdges.length; j++) {
            let coseEdge = incidentCoseEdges[j];
            let edgeIndices = [];
            let ciseEdges = coseEdgeToCiseEdges.get(coseEdge);
            ciseEdges.forEach(function (ciseEdge) {
                let edgeIndex = -1;
                if (ciseEdge.getSource().getOwner() === ciseCircle) {
                    edgeIndex = ciseEdge.getSource().getOnCircleNodeExt().getIndex();
                } else if (ciseEdge.getTarget().getOwner() === ciseCircle) {
                    edgeIndex = ciseEdge.getTarget().getOnCircleNodeExt().getIndex();
                }

                edgeIndices.push(edgeIndex);
            });

            edgeIndices.sort();

            // When averaging indices, we need to make sure it falls to the
            // correct side, simple averaging will not always work. For
            // instance, if indices are 0, 1, and 5 for a 6 node circle /
            // cluster, we want the average to be 0 [=(0+1+(-1))/3] as
            // opposed to 2 [=(0+1+5)/3]. We need to calculate the largest
            // gap between adjacent indices (1 to 5 in this case) here.
            // Indices after the start of the largest gap are to be adjusted
            // (by subtracting mod from each), so the average falls into the
            // correct side.

            let indexLargestGapStart = -1;
            let largestGap = -1;
            let gap;

            // calculate largest gap and its starting index

            let indexIter = edgeIndices[Symbol.iterator]();
            let edgeIndex = null;
            let prevEdgeIndex = null;
            let firstEdgeIndex = -1;
            let edgeIndexPos = -1;

            for (let z = 0; z < edgeIndices.length; z++){
                prevEdgeIndex = edgeIndex;
                edgeIndex =  edgeIndices[z];
                edgeIndexPos++;

                if (prevEdgeIndex !== null)
                {
                    gap = edgeIndex - prevEdgeIndex;

                    if (gap > largestGap)
                    {
                        largestGap = gap;
                        indexLargestGapStart = edgeIndexPos - 1;
                    }
                }
                else
                {
                    firstEdgeIndex = edgeIndex;
                }
            }

            if (firstEdgeIndex !== -1 && (firstEdgeIndex + mod - edgeIndex) > largestGap)
            {
                largestGap = firstEdgeIndex + mod - edgeIndex;
                indexLargestGapStart = edgeIndexPos;
            }

            // adjust indices after the start of the gap (beginning with the
            // index that marks the end of the largest gap)

            let edgeCount = edgeIndices.length;

            if (largestGap > 0)
            {
                let index;

                for (let k = indexLargestGapStart + 1; k < edgeCount; k++)
                {
                    index = edgeIndices[k];
                    edgeIndices[k] = index - mod;
                }
            }

            // Sum up indices
            let averageIndex;
            let totalIndex = 0;

            for (let z = 0; z < edgeIndices.length; z++)
            {
                edgeIndex = edgeIndices[z];
                totalIndex += edgeIndex;
            }

            averageIndex = totalIndex / edgeCount;

            if (averageIndex < 0)
            {
                averageIndex += mod;
            }

            indexMapping.put(coseEdge, averageIndex);
        }

        incidentCoseEdges.sort(function(a, b) {
            return indexMapping.get(a) - indexMapping.get(b);
        });

    }
};

/**
 * This method prepares circles for possible reversal by computing the order
 * matrix of each circle. It also determines any circles that should never
 * be reversed (e.g. when it has no more than 1 inter-cluster edge).
 */

CiSELayout.prototype.prepareCirclesForReversal = function()
{
    let self = this;

    let nodes = this.graphManager.getRoot().getNodes();
    nodes.forEach(function(node){
        let circle = node.getChild();
        if(circle !== null && circle !== undefined){ //It is a circle
            if (circle.getInterClusterEdges().length < 2)
                circle.setMayNotBeReversed();

            circle.computeOrderMatrix();
        }
    });
};

module.exports = CiSELayout;