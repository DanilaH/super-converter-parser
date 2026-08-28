from pathlib import Path

p = Path("src/cli/enrich.ts")
text = p.read_text(encoding="utf-8")
old = """    } else {
      sourceRunId = args.sourceRunId;
      const sourceLocation = await resolveRunLocation(outputRoot, sourceRunId);
      sourceStorePath = resolve(sourceLocation.discoveryDirectory, 'run.sqlite');
      researchDirectory = sourceLocation.researchDirectory;
      archivePath = sourceLocation.archivePath;
      enrichmentId = createRunId();
      enrichmentDirectory = await allocateEnrichmentDirectory(researchDirectory);
      await writeEnrichmentIndex(outputRoot, {
        version: 1,
        enrichmentId,
        runId: sourceRunId,
        researchDirectory,
        enrichmentDirectory,
      });
      clusteringConfig = {
        topN: args.topN,
        edgeRule: {
          minSharedDomains: args.minShared,
          minJaccard: args.minJaccard,
        },
        algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
      };
      modules = args.modules;
      shortlist = modules.includes('query_suggestions') || modules.includes('domain_age')
        ? validateShortlist(sourceStorePath, sourceRunId, args.shortlist)
        : (args.shortlist && args.shortlist.length > 0 ? validateShortlist(sourceStorePath, sourceRunId, args.shortlist) : []);
      if (modules.includes('domain_age')) {
        domainAgeSnapshot = buildDomainAgeConfigSnapshot(config);
      }
    }
"""
new = """    } else {
      sourceRunId = args.sourceRunId;
      const sourceLocation = await resolveRunLocation(outputRoot, sourceRunId);
      sourceStorePath = resolve(sourceLocation.discoveryDirectory, 'run.sqlite');
      researchDirectory = sourceLocation.researchDirectory;
      archivePath = sourceLocation.archivePath;
      modules = args.modules;
      shortlist = args.shortlist.length > 0
        ? validateShortlist(sourceStorePath, sourceRunId, args.shortlist)
        : [];

      // Validate all source-dependent input before allocating an enrichment
      // directory or index entry. Invalid shortlist input must not leave an
      // operator-visible failed run behind.
      enrichmentId = createRunId();
      enrichmentDirectory = await allocateEnrichmentDirectory(researchDirectory);
      await writeEnrichmentIndex(outputRoot, {
        version: 1,
        enrichmentId,
        runId: sourceRunId,
        researchDirectory,
        enrichmentDirectory,
      });
      clusteringConfig = {
        topN: args.topN,
        edgeRule: {
          minSharedDomains: args.minShared,
          minJaccard: args.minJaccard,
        },
        algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
      };
      if (modules.includes('domain_age')) {
        domainAgeSnapshot = buildDomainAgeConfigSnapshot(config);
      }
    }
"""
if text.count(old) != 1:
    raise RuntimeError(f"expected exactly one fresh CLI block, got {text.count(old)}")
p.write_text(text.replace(old, new, 1), encoding="utf-8")
