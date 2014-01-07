#! /usr/bin/env bash

if [ -d "./build" ]; then
	rm -fr ./build;
fi

mkdir ./build
cp -r ../deploy/* ./build

cp ./src/index.html build/index.html
cp ./src/package.json build/package.json

mkdir ./build/extra
cp -H ../../lib/easeljs*.min.js ./build/extra/
cp -H ../../lib/tweenjs*.min.js ./build/extra/
##cp -H ../../lib/jstat.min.js ./build/extra/

cd build

zip -r aep.nw *

cd ..

mv build/aep.nw .


