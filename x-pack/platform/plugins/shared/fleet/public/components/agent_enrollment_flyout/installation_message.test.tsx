/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';

import { createFleetTestRendererMock } from '../../mock';

import { InstallationMessage } from './installation_message';

describe('InstallationMessage', () => {
  it('should resolve the downloads link through the doc links service', () => {
    const renderer = createFleetTestRendererMock();
    const results = renderer.render(<InstallationMessage />);

    expect(results.getByText('downloads page').closest('a')).toHaveAttribute(
      'href',
      renderer.startServices.docLinks.links.fleet.elasticAgentDownloads
    );
  });

  it('should resolve the installation link through the doc links service', () => {
    const renderer = createFleetTestRendererMock();
    const results = renderer.render(<InstallationMessage isManaged={false} />);

    expect(results.getByText('installation docs').closest('a')).toHaveAttribute(
      'href',
      renderer.startServices.docLinks.links.fleet.installElasticAgentStandalone
    );
  });
});
