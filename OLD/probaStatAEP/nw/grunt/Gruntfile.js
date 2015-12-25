module.exports = function(grunt) {

  grunt.initConfig({
    nodewebkit: {
      options: {
        build_dir: '../../build', // Where the build version of my node-webkit app is saved
        version: '0.8.4',
        //credits: './public/credits.html',
        mac_icns: '/Users/remy/Github/dynStudio/src/icon.icns', // Path to the Mac icon file
        mac: true, // We want to build it for mac
        win: true, // We want to build it for win
        linux32: true, // We want linux32
        linux64: true, // We want linux64
      },
      src: ['/Users/remy/Github/statinfAEP/nw/build/**/*'] // Your node-webkit app
    },
  });

  grunt.loadNpmTasks('grunt-node-webkit-builder');
  grunt.registerTask('default', ['nodewebkit']);

};