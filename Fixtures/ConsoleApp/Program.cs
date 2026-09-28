using Heapscape.Fixtures;

FinalizerSamples.Prepare();
using var graph = new FixtureGraph();
graph.WaitWithStackRoots();
