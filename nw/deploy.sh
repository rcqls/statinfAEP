#! /usr/bin/env bash

if [ -d "./build" ]; then
	rm -fr ./build;
fi

mkdir ./build
cp -r ~/devel/js/StatInfJS/deploy/* ./build

cp ./src/aep.html build/aep.html
cp ./src/package.json build/package.json

mkdir ./build/extra
cp -H ~/devel/js/lib/easeljs*.min.js ./build/extra/
cp -H ~/devel/js/lib/tweenjs*.min.js ./build/extra/
##cp -H ../../lib/jstat.min.js ./build/extra/

cd build

zip -r aep.nw *

cd ..

mv build/aep.nw .


