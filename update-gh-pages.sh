#!/bin/bash

#git checkout master aep/aep_html.dyn
#git checkout master aep/aep_html.dyn_cfg

### Uncomment to generate lib/${OPAL_VERSION}/cqls.js
## cd lib;./opal2js;cd ..

dyn -d github aep/aep_html.dyn

cp aep/index.html .

cp aep/aide/*.html aide
