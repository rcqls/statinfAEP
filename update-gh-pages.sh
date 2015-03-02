#!/bin/bash

#git checkout master aep/aep_html.dyn
#git checkout master aep/aep_html.dyn_cfg

dyn -d github aep/aep_html.dyn

cp aep/index.html .

cp aep/aide/*.html aide

