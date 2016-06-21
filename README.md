[![][SiploImage]][Siplo]

Copyright © 2015-2016 [Siplo].

Siplo Media Server
==================
This is the application that handles the live voice and video of Siplo classroom. This project was started using the sourcecode of [Kurento On-to-One tutorial]

Dependancies
------------

* Node Config [node config]

Configuraions
-------------

* All configurations are stored in 'config' directory
* There are three separate config files called dev, prod, and default
* Before start the system the config environment should be specified using NODE_ENV variable. Insert NODE_ENV="production" or NODE_ENV="development" in /etc/environment.





[Siplo]: https://siplo.lk
[SiploImage]: https://www.siplo.lk/bundles/siplouser/images/Logo03.png
[Kurento On-to-One tutorial]: http://www.kurento.org/docs/current/tutorials/node/tutorial-one2one.html
[change resolution]: https://groups.google.com/forum/#!topic/kurento/y7emf5xw784
[node config]: https://github.com/lorenwest/node-config
